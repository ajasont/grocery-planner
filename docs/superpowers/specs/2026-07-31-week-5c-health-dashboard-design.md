# Week 5c — Health Dashboard Design

**Author:** Jason Lee
**Date:** 2026-07-31
**Status:** Draft
**Depends on:** Week 5b (cron refresh) shipped

---

## 1. Overview

Surface the state of the weekly refresh job so that when Sunday's cron fails, we notice.

The 5b cron already writes retailer-level status to `retailer_health` (last success timestamp, last status, last error) but the mapper's per-run counts (`mapped`, `skipped`, `failed`, `error`) evaporate after the HTTP response. There is no UI on top of any of this. This spec fixes both: it persists mapper runs to a new table, adds a `/health` page that surfaces retailer + mapper status with retry actions, and puts a red banner on `/plan` (the page you already open Sunday) whenever anything is wrong.

Scope: a single-user internal maintenance surface. No email/webhook alerting; no planner failure surfacing; no changes to existing auth.

## 2. Goals

- **G1** — Detect and communicate a failed weekly cron run before it silently breaks the following week's plan.
- **G2** — Communicate *why* a run failed (retailer error message, mapper error message) so recovery is fast.
- **G3** — Enable one-click recovery for the common case (retry a single retailer's refresh).
- **G4** — Detect the "cron didn't run at all" failure mode via staleness of `last_success_at`, not just via an explicit FAILED status.

## 3. Non-goals

- Push notifications, email, webhooks. Passive dashboard + inline banner only.
- Planner (`/api/plan/generate`) failure surfacing — the existing `/plan` ErrorBanner covers that.
- Historical retailer refresh log (retailer state stays in the upsert-only `retailer_health`; only mapper runs get an append-only history).
- Multi-user auth or admin-role gating (single-user app behind existing password gate).

## 4. Requirements

### Functional

- A `/health` page renders:
  - Per-retailer status card: name, status (OK / FAILED / STALE / NEVER), `last_success_at` in human-readable form, `last_error` if failed, a Retry button.
  - Latest mapper run: `run_at`, status, mapped/skipped/failed counts, error if failed.
  - History table: the last 4 `job_runs` rows in reverse-chronological order.
- The weekly-refresh cron inserts exactly one `job_runs` row per execution, after the mapper block completes (success or failure).
- The `/plan` page shows a red banner above its existing content when the health snapshot has any problem. Banner links to `/health`.
- Retry buttons on `/health` POST to existing `/api/admin/refresh-{harris-teeter|sprouts}` routes and return to `/health` after completion.
- The mapper's `failed` count is no longer dropped from the cron's JSON response.

### Non-functional

- The dashboard is a Server Component with `dynamic = 'force-dynamic'`, following the pattern used by `/plan` and `/pantry`.
- Staleness threshold: `last_success_at` older than 8 days (or null) counts as STALE. One missed Sunday with buffer.
- Retry admin routes return JSON when `Accept: application/json` is present (preserves curl/test callers) and 302-redirect to `/health` otherwise.
- No new environment variables required.
- No middleware changes (page is behind existing auth by default).

## 5. Architecture

Four pieces:

1. **`job_runs` table** (new) — persists one row per weekly-refresh execution with mapper stats.
2. **`lib/health/status.ts`** (new) — pure-ish `computeHealth()` reads `retailer_health` + `job_runs` and returns a `HealthSnapshot`. Single source of truth for "is anything wrong."
3. **`/health` page** (new) — Server Component renders `computeHealth()` output plus retry forms.
4. **`/plan` page** (modified) — calls `computeHealth()`, renders `HealthBanner` above existing content when `hasProblem` is true.

Related modifications:
- **`app/api/jobs/weekly-refresh/route.ts`** — insert one `job_runs` row after mapper block.
- **`app/api/admin/refresh-{ht,sprouts}/route.ts`** — Accept-header branching (JSON vs. 302 redirect).
- **Nav** — add "Health" link to the existing nav row on `/plan`, `/pantry`, `/plan/shopping-list`.

### Component boundaries

| Unit | Purpose | Depends on | Consumed by |
|---|---|---|---|
| `job_runs` table | Store per-run mapper stats | — | cron, `computeHealth` |
| `lib/health/status.ts` | Compute `HealthSnapshot` from DB | `retailer_health`, `job_runs`, retailers | `/health`, `/plan` |
| `app/health/page.tsx` | Render dashboard | `computeHealth` | user |
| `app/plan/HealthBanner.tsx` | Render banner given snapshot | — | `/plan` page |

## 6. Data model

### New table

```sql
create table job_runs (
  id serial primary key,
  run_at timestamptz not null default now(),
  mapper_status text not null check (mapper_status in ('OK', 'FAILED')),
  mapper_mapped int not null default 0,
  mapper_skipped int not null default 0,
  mapper_failed int not null default 0,
  mapper_error text
);

create index idx_job_runs_run_at on job_runs (run_at desc);
```

Migration file: `supabase/migrations/0003_job_runs.sql`.

Types added to `lib/db/types.ts`:

```typescript
export type JobRun = {
  id: number;
  run_at: string;
  mapper_status: 'OK' | 'FAILED';
  mapper_mapped: number;
  mapper_skipped: number;
  mapper_failed: number;
  mapper_error: string | null;
};
```

### `retailer_health` — unchanged

Already the right shape:

```sql
retailer_health (
  id, retailer_id, last_success_at, last_status, last_error
)
```

## 7. Status helper

`lib/health/status.ts`:

```typescript
export const STALE_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;

export type RetailerHealthStatus = 'OK' | 'FAILED' | 'STALE' | 'NEVER';

export type RetailerStatus = {
  name: RefreshRetailerName;
  displayName: string;
  status: RetailerHealthStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type MapperStatus = {
  runAt: string;
  status: 'OK' | 'FAILED';
  mapped: number;
  skipped: number;
  failed: number;
  error: string | null;
} | null;

export type HealthSnapshot = {
  hasProblem: boolean;
  retailers: RetailerStatus[];
  mapper: MapperStatus;
  history: NonNullable<MapperStatus>[];
};

export async function computeHealth(): Promise<HealthSnapshot>;
```

**`hasProblem` is true when:**
- Any retailer's `status !== 'OK'`, OR
- `mapper !== null && mapper.status === 'FAILED'`.

**Retailer status mapping:**
- `retailer_health.last_status === 'OK'` and `last_success_at` within 8 days → `OK`.
- `last_status === 'OK'` but `last_success_at` older than 8 days → `STALE`.
- `last_status === 'FAILED'` → `FAILED`.
- No `retailer_health` row at all → `NEVER`.

**Edge cases:**
- Missing `retailer_health` row entirely → `NEVER`.
- Row exists, `last_status === 'FAILED'`, `last_success_at` null → `FAILED` (the retailer has never succeeded).
- Row exists, `last_status === 'OK'`, `last_success_at` null → `STALE` (defensive; this shouldn't happen but the schema allows it, and treating "we don't know when it last worked" as stale is safer than as OK).

**Display names:** `retailers` has only `name` (slug). Use a static map in the status helper: `{ 'harris-teeter': 'Harris Teeter', 'sprouts': 'Sprouts' }`.

**Reads:**
- `retailer_health` joined with `retailers` for display names.
- `job_runs` — latest row → `mapper` field (the "Latest" card). The 4 rows *before* that → `history` field (the "Recent runs" table). `mapper` and `history` are disjoint, giving 5 total data points visible on the page (~5 weeks of Sundays).

## 8. Cron route change

`app/api/jobs/weekly-refresh/route.ts`:

1. Change `mapper` local to include `failed` (currently drops it): `{ mapped, skipped, failed, error }`.
2. Include `mapper_failed` in the cron JSON response.
3. Before returning, insert a single `job_runs` row:

```typescript
const supabase = getServerClient();
await supabase.from('job_runs').insert({
  mapper_status: mapper.error === null ? 'OK' : 'FAILED',
  mapper_mapped: mapper.mapped,
  mapper_skipped: mapper.skipped,
  mapper_failed: mapper.failed,
  mapper_error: mapper.error,
});
```

The insert is best-effort — if it errors, the cron still returns 200 with the response envelope. Log the error and swallow. (Rationale: a failed persistence write should not mask what actually happened during the refresh, and it will show up as a missing row in the dashboard — which is itself a signal.)

## 9. `/health` page

`app/health/page.tsx` — Server Component with `dynamic = 'force-dynamic'`:

```
Health

[← Back to plan]  [Pantry →]

[Status banner]
  Green: "All systems healthy"
  Red:   "Refresh problem detected"

## Retailers
Harris Teeter    OK       last success: 2 hours ago    [Retry]
Sprouts          FAILED   last success: 8 days ago     [Retry]
                 Error: Kroger API 503

## Mapper — last run
Sun Jul 26 09:00   OK     152 mapped / 12 skipped / 0 failed

## Recent runs
2026-07-26 09:00   OK     148 / 14 / 0
2026-07-19 09:00   OK     140 / 11 / 0
2026-07-12 09:00   FAIL   0 / 0 / 0     Anthropic timeout
```

Timestamps use `Intl.RelativeTimeFormat` for the retailer card ("2 hours ago") and locale date-time strings for the history table.

### Retry forms

Two client-free forms per retailer:

```tsx
<form action="/api/admin/refresh-ht" method="POST">
  <button type="submit">Retry Harris Teeter</button>
</form>
```

### Admin route change

`app/api/admin/refresh-{ht,sprouts}/route.ts` — branch on `Accept` header:

```typescript
const accept = req.headers.get('accept') ?? '';
if (accept.includes('application/json')) {
  return NextResponse.json({ ok, ...result, skusMapped, skusSkipped, mapperError? });
}
return NextResponse.redirect(new URL('/health', req.url), 303);
```

303 (See Other) because the request was a POST but we want the browser to follow with GET.

Existing JSON callers (curl, tests) send `Accept: application/json` explicitly or the tests use the JSON path directly.

## 10. Banner on `/plan`

`app/plan/HealthBanner.tsx` — trivial red-tint box mirroring `ErrorBanner` in `app/plan/page.tsx:31`.

`app/plan/page.tsx` — insert above `<GenerateForm>` / plan grid:

```tsx
const health = await computeHealth();
{health.hasProblem && <HealthBanner health={health} />}
```

**Copy rules** (single line, context-aware):

- Exactly one retailer FAILED: "Sunday refresh failed for {retailer} — [view health]"
- Exactly one retailer STALE: "No refresh in {N} days for {retailer} — [view health]"
- Mapper FAILED, retailers OK: "Ingredient mapping failed on last refresh — [view health]"
- Two or more problems (any combination): "Refresh problems detected — [view health]"

`[view health]` is a `<Link href="/health">`.

## 11. Navigation

Add a "Health" link to the existing nav row on `/plan`, `/pantry`, `/plan/shopping-list`. Follows the existing pattern:

```tsx
<Link href="/health" className="text-sm text-blue-600 hover:underline">
  Health
</Link>
```

## 12. Testing

- **`tests/health/status.test.ts`** — unit tests for `computeHealth()`:
  - All retailers OK, mapper OK → `hasProblem: false`.
  - One retailer FAILED → `hasProblem: true`.
  - One retailer STALE (last_success_at = 9 days ago) → `hasProblem: true`.
  - No retailer_health row → NEVER + `hasProblem: true`.
  - Mapper FAILED, retailers OK → `hasProblem: true`.
  - Staleness boundary: exactly 8 days ago → OK; 8 days + 1 minute ago → STALE.
- **`tests/api/weekly-refresh.test.ts`** (extend or create) — verify:
  - On success path, one `job_runs` row is inserted with `mapper_status: 'OK'` and non-zero counts.
  - On mapper-failure path, one `job_runs` row is inserted with `mapper_status: 'FAILED'` and the error string.
  - Response envelope now includes `mapper.failed`.
- **`tests/api/admin-refresh.test.ts`** — Accept-header branching:
  - `Accept: application/json` → 200 JSON body.
  - Missing / `text/html` → 303 with `Location: /health`.

No UI tests (Playwright/e2e) — the components are all Server Components with trivial rendering, and existing pages don't test at that level.

## 13. Rollout

1. Apply migration `0003_job_runs.sql` to remote Supabase via the pattern used for prior migrations.
2. Merge PR — Vercel auto-deploys.
3. Manual verification:
   - Hit `/api/admin/refresh-ht` (POST with valid `CRON_SECRET` or via the new `/health` button) → verify a `job_runs` row appears.
   - Open `/health` — verify retailer cards + mapper card + history render.
   - Temporarily unset `KROGER_CLIENT_ID` in Preview (or use a bad SKU list) and re-run to see a failure row + banner on `/plan`. Revert.
4. Wait for the following Sunday cron. Verify a new `job_runs` row appears at `run_at ≈ 14:00 UTC`.

## 14. Open considerations for later

- **Alerting (email/webhook)** when `hasProblem` becomes true. Original Question 1's option C — deferred until the passive surface proves insufficient.
- **Planner run history** — surface last N `/api/plan/generate` outcomes. Currently no persistence for those.
- **Retailer refresh history** — turn `retailer_health` into an append-only log if trend analysis becomes valuable.
- **Health snapshot caching** — currently every `/plan` render calls `computeHealth()`. If page loads matter, wrap it in a short-lived server cache. Not needed for MVP (single user).

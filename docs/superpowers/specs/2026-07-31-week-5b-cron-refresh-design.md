# Week 5b — Vercel Cron Weekly Refresh — Design

**Status:** Approved, ready for planning.
**Milestone context:** Week 5 (`docs/superpowers/specs/2026-07-23-grocery-meal-planner-design.md` §17) covers Pantry state (5a — shipped), Vercel Cron weekly refresh (5b — this doc), Health Dashboard (5c — later), Meal ratings (5d — later).

## 1. Scope

**In scope**
- New `GET /api/jobs/weekly-refresh` cron endpoint, auth-gated by `Authorization: Bearer $CRON_SECRET` (Vercel Cron injects this header automatically when the env var is set on the project).
- `vercel.json` cron entry with schedule `0 10 * * 0` (Sunday 10:00 UTC ≈ 6 AM ET winter/summer, DST drift accepted per master spec §12).
- New `lib/ingestion/refresh.ts` with a `refreshRetailer(name)` helper that never throws — it catches all errors, flips `retailer_health` to `FAILED` with the message, and returns a `RefreshResult`.
- Refactor `POST /api/admin/refresh-ht` and `POST /api/admin/refresh-sprouts` to call the same helper so single-retailer manual refreshes and cron-driven refreshes share one code path.
- Middleware `PUBLIC_PATHS` bypass for `/api/jobs/weekly-refresh` — cron requests carry the bearer header, not the shared-password cookie.

**Out of scope (deferred, not forgotten)**
- `refresh_runs` audit table — moved to 5c (Health Dashboard) where its schema can be shaped by the dashboard's actual needs.
- Inline retries. Per the failure-policy decision below, next Sunday's cron is the retry.
- Target / Safeway / Giant Food ingestion — still spec-only per master doc §7, added in a later week.
- Fixing `persistDeals` transactionality — deals table is upsert-only, so a mid-flight persist failure at worst leaves the previous week's row untouched. Not worth complicating for a personal-use app.

## 2. Design decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Partial success returns 200.** Per-retailer `status` fields (`OK`/`FAILED`) in the response body. Health rows updated per retailer independently. | Ingestion failures are usually retailer-side blips (Kroger API hiccup, Flipp shape change). Partial data > no update. Flagging the whole run as failed would be misleading when half of it worked. |
| Q2 | **No `refresh_runs` audit table in 5b.** `retailer_health` (single most-recent row per retailer) is the only observability surface. | YAGNI. 5c will need the audit history and can design its schema against the actual dashboard requirements. Vercel Cron's own run log holds recent runs until then. |
| Q3 | **Schedule = `0 10 * * 0`** (Sunday 10:00 UTC). | Matches master spec §12. Late enough that retailer sites have posted the new week's deals if they update Saturday night; early enough to be done before Sunday-morning coffee planning. |
| — | **Shared helper.** `refreshRetailer(name)` used by both cron and admin endpoints. | Single source of truth for "refresh one retailer" — prevents drift when we add Target/Safeway/Giant. Also the natural home for the FAILED-health fix. |
| — | **Mapper runs once at the end.** Not per-retailer. | Efficiency + simpler contract. Wrapped in its own try/catch so mapper failure doesn't sink the response. |

## 3. Architecture

### 3.1 File structure

**New files**
- `lib/ingestion/refresh.ts` — `refreshRetailer(name): Promise<RefreshResult>`. Owns the "fetch → persist → error-catch → health FAILED" flow for one retailer. Never throws.
- `app/api/jobs/weekly-refresh/route.ts` — cron entrypoint. Thin: verify bearer, run helpers in parallel, run mapper, return summary JSON.
- `vercel.json` — one cron entry pointing at that route.
- `tests/ingestion/refresh.test.ts` — unit coverage for the helper's success and failure paths.

**Modified files**
- `middleware.ts` — add `/api/jobs/weekly-refresh` to `PUBLIC_PATHS`.
- `app/api/admin/refresh-ht/route.ts` — replace inline body with `refreshRetailer('harris-teeter')` + mapper.
- `app/api/admin/refresh-sprouts/route.ts` — same, for Sprouts.

**Explicitly unchanged**
- `lib/ingestion/persist.ts` — stays a pure "if we get here, we succeeded" module. All FAILED-path health writes live in the new helper. `touchHealth('OK', null)` still fires from `persistDeals` on success.
- `lib/normalization/runner.ts` — reused as-is.
- Individual retailer ingestion modules (`lib/ingestion/harris-teeter/*`, `lib/ingestion/sprouts/*`) — reused as-is.

### 3.2 Component contracts

**`refreshRetailer(name)`**

```ts
type RetailerName = 'harris-teeter' | 'sprouts';

export type RefreshResult = {
  retailer: RetailerName;
  status: 'OK' | 'FAILED';
  dealsFetched: number;
  dealsUpserted: number;
  error: string | null;
};

export async function refreshRetailer(name: RetailerName): Promise<RefreshResult>;
```

Behavior:
- Dispatches internally to `fetchHarrisTeeterDeals` or `fetchSproutsDeals` (hardcoded `ZIP = '21224'`, matching existing admin endpoints).
- On success: calls `persistDeals(...)`, which touches `retailer_health` to `OK`. Returns `status: 'OK'` with populated counts, `error: null`.
- On any thrown error: catches, best-effort writes `retailer_health` with `status: 'FAILED', last_error: err.message`, returns `status: 'FAILED'` with `dealsFetched: 0`, `dealsUpserted: 0`, `error` set.
- Health-write failure inside the catch block is swallowed silently — a `RefreshResult` is always returned.

**`GET /api/jobs/weekly-refresh`**

- Reads `Authorization` header. If not `Bearer <CRON_SECRET>`, returns 401 with no body.
- Runs `Promise.allSettled([refreshRetailer('harris-teeter'), refreshRetailer('sprouts')])`. Belt-and-suspenders — the helper doesn't throw, but `allSettled` guards against any unexpected panic.
- Runs `runMappingForUnmappedSkus()` wrapped in its own try/catch. Failure sets `mapper.error`; the top-level response is still 200.
- Response body:
  ```ts
  {
    runAt: string,                              // ISO timestamp
    results: RefreshResult[],
    mapper: { mapped: number, skipped: number, error: string | null }
  }
  ```

### 3.3 Data flow

**Happy path (Sunday morning):**
```
Sunday 10:00 UTC
  → Vercel Cron: GET /api/jobs/weekly-refresh
    with Authorization: Bearer $CRON_SECRET
  → middleware sees path in PUBLIC_PATHS → passes through
  → route: verify header
  → Promise.allSettled([
       refreshRetailer('harris-teeter'),   refreshRetailer('sprouts')
       ├─ fetchHarrisTeeterDeals(ZIP)      ├─ fetchSproutsDeals(ZIP)
       └─ persistDeals(...)                └─ persistDeals(...)
           └─ touchHealth OK                    └─ touchHealth OK
     ])
  → runMappingForUnmappedSkus()
  → 200 { runAt, results: [OK, OK], mapper: {mapped, skipped, error: null} }
```

**Partial-failure path (e.g., Sprouts errors, HT succeeds):**
```
… Promise.allSettled([
     refreshRetailer('harris-teeter') → OK
     refreshRetailer('sprouts')
       ├─ fetchSproutsDeals throws
       └─ catch → touchHealth FAILED → return {status: 'FAILED', error}
   ])
  → runMappingForUnmappedSkus() (still runs — catches up on prior week's unmapped rows)
  → 200 { runAt, results: [OK, FAILED], mapper: {...} }
```

### 3.4 Error handling

| Failure | Behavior |
|---|---|
| One retailer's fetch throws | Helper catches → `touchHealth('FAILED', err.message)` for that retailer → returns `status: 'FAILED'`. Other retailer unaffected. |
| `persistDeals` throws mid-flight | Same as fetch failure. Note: `persistDeals` is not transactional; a mid-flight failure may leave partial writes. Safe because deals rows are upsert-only on `(retailer_sku_id, store_id, week_of)` — next Sunday's run cleans up. |
| Mapper throws | Route catches → `mapper.error` populated, `mapped/skipped` set to 0. Retailer results still returned. |
| Bad or missing bearer token | 401 with no body. |
| Middleware misconfig sends cron path to `/login` | 307 redirect — Vercel Cron surfaces as a failed run. Guarded by a unit test asserting `/api/jobs/weekly-refresh` matches `PUBLIC_PATHS` logic. |
| Manual admin call collides with cron | Both writes upsert into the same `(week_of, sku, store)` deals row. Last write wins on price; harmless. |

## 4. Testing

### 4.1 Unit — `tests/ingestion/refresh.test.ts`

Approach: refactor `refreshRetailer`'s internal fetch dispatch behind an injectable `Fetcher` type so tests can inject stubs without hitting the network. Supabase client mocked with a minimal fake that captures the `retailer_health` upsert call.

Cases:
- **Success path:** stubbed fetcher returns fake stores + deals; assert helper returns `{status: 'OK'}` with correct counts.
- **Fetch failure:** stubbed fetcher throws; assert helper returns `{status: 'FAILED', error: '...'}` AND a `retailer_health` upsert was called with `last_status: 'FAILED'` and the error message.
- **Persist failure:** persist mocked to throw; assert same shape.

No new tests for the cron route or the admin routes — they're thin wrappers, and adding Next Request/Response mocking for two ~15-line handlers is more test infra than it earns.

### 4.2 Middleware guard

One-line addition to whatever middleware test coverage exists (or a new small test file if none): assert that `/api/jobs/weekly-refresh` passes the `PUBLIC_PATHS` bypass check. This is the fuse against accidentally regressing middleware and breaking the cron.

### 4.3 Manual smoke — dev

```bash
CRON_SECRET=devsecret npm run dev
# In another shell:
curl -s http://localhost:3000/api/jobs/weekly-refresh \
  -H "Authorization: Bearer devsecret" | jq
# Expected: 200, both retailers OK (or realistic FAILED if the retailer is actually broken).

curl -sI http://localhost:3000/api/jobs/weekly-refresh
# Expected: 401.
```

### 4.4 Production verification

- Add `CRON_SECRET` in Vercel project env (Production + Preview + Development) before merge.
- After merge, in Vercel Dashboard → Cron Jobs, confirm the schedule shows and the next-run timestamp is correct.
- Following Sunday, check the run log + query `retailer_health` for a fresh `last_success_at`.

## 5. Env vars

- **`CRON_SECRET`** — new. Random string. Set in Vercel (Prod + Preview + Dev) before merging the PR. Also set in `.env.local` for dev smoke testing.

No other env changes.

## 6. Rollout

1. Land the PR after preview smoke test passes.
2. Set `CRON_SECRET` in Vercel env if not already present.
3. Vercel picks up `vercel.json` on deploy and schedules the cron automatically.
4. Verify the cron entry appears in the Vercel Dashboard.
5. Next Sunday: check run log + `retailer_health.last_success_at`.

Rollback: delete `vercel.json`'s cron entry (or the whole file) and redeploy. The endpoint stays but stops being triggered. No DB state to unwind.

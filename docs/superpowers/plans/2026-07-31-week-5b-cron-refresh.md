# Week 5b — Vercel Cron Weekly Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Sunday 10:00 UTC Vercel Cron that refreshes Harris Teeter + Sprouts deals via a shared, never-throwing `refreshRetailer` helper. Existing admin endpoints get refactored onto the same helper. `retailer_health` correctly flips to `FAILED` on error (a live bug).

**Architecture:** New `lib/ingestion/refresh.ts` owns "refresh one retailer" — dispatches to the right fetcher, calls `persistDeals`, catches all errors, and best-effort writes `retailer_health` FAILED preserving the previous `last_success_at`. A new `GET /api/jobs/weekly-refresh` route verifies `Authorization: Bearer $CRON_SECRET`, runs the helper in parallel for both retailers via `Promise.allSettled`, runs the mapper once at the end, and returns a JSON summary. Both existing admin endpoints refactor onto the same helper (one-line handlers). Middleware gets a small refactor to extract `isPublicPath` for testability, then adds the cron path to the bypass list.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres), Vitest, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-07-31-week-5b-cron-refresh-design.md`

---

## Preflight

- [ ] **Step 1: Verify you're on the feature branch**

```bash
cd ~/Documents/Coding/grocery-planner
git branch --show-current
```

Expected: `week-5b-cron-refresh`. If not, this branch was already created off `main` and includes the design spec commit. Check it out with `git checkout week-5b-cron-refresh`.

- [ ] **Step 2: Add `CRON_SECRET` to `.env.local` for dev smoke testing**

The example file already declares it (`.env.local.example:17`). Pick any random string:

```bash
# Add or update this line in .env.local — do NOT commit .env.local
CRON_SECRET=devsecret-changeme
```

Verify with: `grep CRON_SECRET .env.local`. Expected: a non-empty value.

- [ ] **Step 3: Confirm tests and typecheck pass**

```bash
npm test -- --run
npx tsc --noEmit
```

Expected: all 145 tests pass. `tsc` reports only the pre-existing errors under `tests/ingestion/harris-teeter/*` and `tests/normalization/runner.test.ts`. Any error in `lib/ingestion/`, `app/api/jobs/`, `middleware.ts`, or `tests/ingestion/refresh.test.ts` is ours to fix during the plan.

---

## Task 1: `refreshRetailer` helper (TDD)

**Files:**
- Create: `lib/ingestion/refresh.ts`
- Create: `tests/ingestion/refresh.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ingestion/refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchHT = vi.fn();
const mockFetchSprouts = vi.fn();
const mockPersist = vi.fn();

vi.mock('@/lib/ingestion/harris-teeter', () => ({
  fetchHarrisTeeterDeals: (zip: string) => mockFetchHT(zip),
}));
vi.mock('@/lib/ingestion/sprouts', () => ({
  fetchSproutsDeals: (zip: string) => mockFetchSprouts(zip),
}));
vi.mock('@/lib/ingestion/persist', () => ({
  persistDeals: (input: unknown) => mockPersist(input),
}));

// Supabase mock — fluent chain used by touchHealthFailed for the retailers lookup
// and the retailer_health preserve+upsert.
const healthUpsertSpy = vi.fn(async () => ({ error: null }));
const healthMaybeSingleSpy = vi.fn(async () => ({
  data: { last_success_at: '2026-07-24T10:00:00.000Z' },
  error: null,
}));
const retailerSingleSpy = vi.fn(async () => ({ data: { id: 7 }, error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'retailers') {
        return {
          select: () => ({
            eq: () => ({ single: retailerSingleSpy }),
          }),
        };
      }
      if (table === 'retailer_health') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: healthMaybeSingleSpy }),
          }),
          upsert: healthUpsertSpy,
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { refreshRetailer } from '@/lib/ingestion/refresh';

beforeEach(() => {
  mockFetchHT.mockReset();
  mockFetchSprouts.mockReset();
  mockPersist.mockReset();
  healthUpsertSpy.mockClear();
  healthMaybeSingleSpy.mockClear();
  retailerSingleSpy.mockClear();
});

describe('refreshRetailer', () => {
  it('returns OK with counts on a successful HT refresh', async () => {
    mockFetchHT.mockResolvedValueOnce({
      stores: [{ store_number: '00123', address: null, zip: '21224' }],
      deals: [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }],
    });
    mockPersist.mockResolvedValueOnce({ dealsUpserted: 3 });

    const result = await refreshRetailer('harris-teeter');

    expect(result).toEqual({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    expect(mockFetchHT).toHaveBeenCalledWith('21224');
    expect(mockPersist).toHaveBeenCalledWith({
      retailer: 'harris-teeter',
      stores: [{ store_number: '00123', address: null, zip: '21224' }],
      deals: [{ sku: 'a' }, { sku: 'b' }, { sku: 'c' }],
    });
    // Success path does NOT touch retailer_health from the helper —
    // persistDeals owns the OK write.
    expect(healthUpsertSpy).not.toHaveBeenCalled();
  });

  it('returns FAILED and flips retailer_health when the fetcher throws', async () => {
    mockFetchHT.mockRejectedValueOnce(new Error('Kroger API 503'));

    const result = await refreshRetailer('harris-teeter');

    expect(result).toEqual({
      retailer: 'harris-teeter',
      status: 'FAILED',
      dealsFetched: 0,
      dealsUpserted: 0,
      error: 'Kroger API 503',
    });
    expect(mockPersist).not.toHaveBeenCalled();
    // Preserved last_success_at from the maybeSingle stub above.
    expect(healthUpsertSpy).toHaveBeenCalledWith(
      {
        retailer_id: 7,
        last_success_at: '2026-07-24T10:00:00.000Z',
        last_status: 'FAILED',
        last_error: 'Kroger API 503',
      },
      { onConflict: 'retailer_id' }
    );
  });

  it('returns FAILED when persistDeals throws', async () => {
    mockFetchSprouts.mockResolvedValueOnce({
      stores: [{ store_number: 'flipp-2419', address: null, zip: '21224' }],
      deals: [{ sku: 'x' }],
    });
    mockPersist.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await refreshRetailer('sprouts');

    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('DB timeout');
    expect(healthUpsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        retailer_id: 7,
        last_status: 'FAILED',
        last_error: 'DB timeout',
      }),
      { onConflict: 'retailer_id' }
    );
  });

  it('still returns FAILED cleanly if the health write itself fails', async () => {
    mockFetchHT.mockRejectedValueOnce(new Error('boom'));
    healthUpsertSpy.mockResolvedValueOnce({ error: { message: 'DB unreachable' } });

    const result = await refreshRetailer('harris-teeter');

    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/ingestion/refresh.test.ts`
Expected: FAIL — cannot resolve `@/lib/ingestion/refresh`.

- [ ] **Step 3: Create the helper module**

Create `lib/ingestion/refresh.ts`:

```typescript
import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { fetchSproutsDeals } from '@/lib/ingestion/sprouts';
import { persistDeals } from '@/lib/ingestion/persist';
import { getServerClient } from '@/lib/db/client';

const ZIP = '21224';

export type RefreshRetailerName = 'harris-teeter' | 'sprouts';

export type RefreshResult = {
  retailer: RefreshRetailerName;
  status: 'OK' | 'FAILED';
  dealsFetched: number;
  dealsUpserted: number;
  error: string | null;
};

async function fetchFor(name: RefreshRetailerName) {
  if (name === 'harris-teeter') return fetchHarrisTeeterDeals(ZIP);
  return fetchSproutsDeals(ZIP);
}

async function touchHealthFailed(
  name: RefreshRetailerName,
  message: string
): Promise<void> {
  const supabase = getServerClient();
  const { data: retailerRow, error: rErr } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', name)
    .single();
  if (rErr || !retailerRow) return;
  const retailerId = retailerRow.id;

  // Preserve last_success_at so the dashboard can still show "last good sync".
  const { data: existing } = await supabase
    .from('retailer_health')
    .select('last_success_at')
    .eq('retailer_id', retailerId)
    .maybeSingle();

  await supabase.from('retailer_health').upsert(
    {
      retailer_id: retailerId,
      last_success_at: existing?.last_success_at ?? null,
      last_status: 'FAILED',
      last_error: message,
    },
    { onConflict: 'retailer_id' }
  );
}

export async function refreshRetailer(
  name: RefreshRetailerName
): Promise<RefreshResult> {
  try {
    const fetched = await fetchFor(name);
    const persisted = await persistDeals({
      retailer: name,
      stores: fetched.stores,
      deals: fetched.deals,
    });
    return {
      retailer: name,
      status: 'OK',
      dealsFetched: fetched.deals.length,
      dealsUpserted: persisted.dealsUpserted,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await touchHealthFailed(name, message);
    } catch {
      // Swallow — the caller always gets a RefreshResult.
    }
    return {
      retailer: name,
      status: 'FAILED',
      dealsFetched: 0,
      dealsUpserted: 0,
      error: message,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/ingestion/refresh.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors in `lib/ingestion/` or `tests/ingestion/`.

- [ ] **Step 6: Commit**

```bash
git add lib/ingestion/refresh.ts tests/ingestion/refresh.test.ts
git commit -m "Ingestion: refreshRetailer helper with FAILED health flip"
```

---

## Task 2: Cron endpoint

**Files:**
- Create: `app/api/jobs/weekly-refresh/route.ts`

No unit test — the route is a thin wrapper around `refreshRetailer` (already covered) and `runMappingForUnmappedSkus` (already covered by its own tests).

- [ ] **Step 1: Create the route**

Create `app/api/jobs/weekly-refresh/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer, type RefreshResult } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

const RETAILERS = ['harris-teeter', 'sprouts'] as const;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const settled = await Promise.allSettled(
    RETAILERS.map((r) => refreshRetailer(r))
  );
  const results: RefreshResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          retailer: RETAILERS[i],
          status: 'FAILED',
          dealsFetched: 0,
          dealsUpserted: 0,
          error:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
        }
  );

  let mapper: { mapped: number; skipped: number; error: string | null };
  try {
    const m = await runMappingForUnmappedSkus();
    mapper = { mapped: m.mapped, skipped: m.skipped, error: null };
  } catch (err) {
    mapper = {
      mapped: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return NextResponse.json({
    runAt: new Date().toISOString(),
    results,
    mapper,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/jobs/weekly-refresh/route.ts
git commit -m "Weekly refresh: cron endpoint with bearer auth"
```

---

## Task 3: Middleware bypass + guard test

**Files:**
- Modify: `middleware.ts`
- Create: `tests/middleware.test.ts`

The current `middleware.ts` has the `PUBLIC_PATHS` list and the matching predicate inlined inside `middleware()`. We extract `isPublicPath()` as an exported pure function so we can unit-test it, then add `/api/jobs/weekly-refresh` to the list.

- [ ] **Step 1: Write the failing test**

Create `tests/middleware.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isPublicPath } from '@/middleware';

describe('isPublicPath', () => {
  it('lets the Vercel Cron path through without auth', () => {
    expect(isPublicPath('/api/jobs/weekly-refresh')).toBe(true);
  });

  it('lets login and auth endpoints through', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
  });

  it('still requires auth for regular app paths', () => {
    expect(isPublicPath('/plan')).toBe(false);
    expect(isPublicPath('/pantry')).toBe(false);
    expect(isPublicPath('/api/plan/generate')).toBe(false);
    expect(isPublicPath('/api/admin/refresh-ht')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/middleware.test.ts`
Expected: FAIL — `isPublicPath` is not exported from `@/middleware`.

- [ ] **Step 3: Refactor middleware to export `isPublicPath` and add the cron path**

Replace the contents of `middleware.ts` with:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';

const COOKIE_NAME = 'gp_session';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/jobs/weekly-refresh',
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
  try {
    await verifySession(token);
    return NextResponse.next();
  } catch {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/middleware.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add middleware.ts tests/middleware.test.ts
git commit -m "Middleware: exported isPublicPath + bypass for /api/jobs/weekly-refresh"
```

---

## Task 4: Refactor `/api/admin/refresh-ht` onto the shared helper

**Files:**
- Modify: `app/api/admin/refresh-ht/route.ts`

- [ ] **Step 1: Replace the handler body**

Replace the contents of `app/api/admin/refresh-ht/route.ts` with:

```typescript
import { NextResponse } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST() {
  const result = await refreshRetailer('harris-teeter');
  try {
    const mapping = await runMappingForUnmappedSkus();
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
    });
  } catch (err) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: 0,
      skusSkipped: 0,
      mapperError: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Note: the response shape here differs slightly from the previous version (adds `retailer`, `status`, `error`; loses `stores`, `dealsFetched` name). Nothing in the app consumes this response — it's a manual debugging endpoint hit from `curl` or a browser. The new fields are strictly more informative.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/refresh-ht/route.ts
git commit -m "Admin: refresh-ht uses shared refreshRetailer helper"
```

---

## Task 5: Refactor `/api/admin/refresh-sprouts` onto the shared helper

**Files:**
- Modify: `app/api/admin/refresh-sprouts/route.ts`

- [ ] **Step 1: Replace the handler body**

Replace the contents of `app/api/admin/refresh-sprouts/route.ts` with:

```typescript
import { NextResponse } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST() {
  const result = await refreshRetailer('sprouts');
  try {
    const mapping = await runMappingForUnmappedSkus();
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
    });
  } catch (err) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: 0,
      skusSkipped: 0,
      mapperError: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/refresh-sprouts/route.ts
git commit -m "Admin: refresh-sprouts uses shared refreshRetailer helper"
```

---

## Task 6: `vercel.json` cron entry

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Create the config**

Create `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/jobs/weekly-refresh",
      "schedule": "0 10 * * 0"
    }
  ]
}
```

- [ ] **Step 2: Verify no other Vercel-side config was expected**

Run: `ls vercel.json && cat vercel.json`
Expected: the single-cron JSON as above. Vercel Cron auto-injects `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set in the project's env vars — the schedule cadence and the endpoint are the only settings Vercel needs.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "Vercel: Sunday 10:00 UTC cron for weekly refresh"
```

---

## Task 7: Full local verification

- [ ] **Step 1: Run the full Vitest suite**

```bash
npm test -- --run
```

Expected: everything green — 145 previous + 4 new (`refreshRetailer`) + 3 new (`isPublicPath`) = 152 tests.

- [ ] **Step 2: Typecheck the whole app**

```bash
npx tsc --noEmit
```

Expected: only the pre-existing errors under `tests/ingestion/harris-teeter/*` and `tests/normalization/runner.test.ts`. Nothing in `app/`, `lib/`, `middleware.ts`, or new test files.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev
```

Expected: server up on `http://localhost:3000`.

- [ ] **Step 4: Smoke test — auth failures**

In another terminal:

```bash
# Missing header → 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/jobs/weekly-refresh

# Wrong secret → 401
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong" \
  http://localhost:3000/api/jobs/weekly-refresh
```

Expected: both print `401`.

- [ ] **Step 5: Smoke test — golden path**

```bash
# Use the CRON_SECRET value you set in .env.local.
CRON_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2)
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/jobs/weekly-refresh | jq
```

Expected: 200 with a JSON body of shape

```json
{
  "runAt": "2026-07-31T...",
  "results": [
    {"retailer": "harris-teeter", "status": "OK", "dealsFetched": <int>, "dealsUpserted": <int>, "error": null},
    {"retailer": "sprouts",       "status": "OK", "dealsFetched": <int>, "dealsUpserted": <int>, "error": null}
  ],
  "mapper": {"mapped": <int>, "skipped": <int>, "error": null}
}
```

If either retailer legitimately errors (e.g., Kroger 429), you'll see `status: "FAILED"` with a real `error` — that proves the FAILED-path also works. That's fine for the smoke test; do not treat as a plan failure.

- [ ] **Step 6: Smoke test — admin endpoints still work**

```bash
# Log in via /login in a browser to get the session cookie into your curl.
# Or copy the gp_session cookie from your browser's devtools:
COOKIE='gp_session=<paste-value>'

curl -s -X POST -H "Cookie: $COOKIE" http://localhost:3000/api/admin/refresh-ht | jq
curl -s -X POST -H "Cookie: $COOKIE" http://localhost:3000/api/admin/refresh-sprouts | jq
```

Expected: 200 with `ok: true` and per-retailer status fields. If cookie management is a hassle, this step is optional — the unit test on the helper already covers the behavior; the admin endpoints only add a mapper call the cron endpoint already exercises.

- [ ] **Step 7: Verify retailer_health FAILED write manually (optional but recommended)**

Use the Supabase Dashboard SQL Editor:

```sql
select r.name, h.last_success_at, h.last_status, h.last_error
from retailer_health h
join retailers r on r.id = h.retailer_id
order by r.name;
```

Expected after Step 5 (golden path succeeded): `last_status = 'OK'`, fresh `last_success_at`. If you ran a scenario that triggered FAILED (e.g., temporarily invalidating an env var), verify `last_status = 'FAILED'` with `last_success_at` preserved from a prior success.

Nothing to commit for verification. If any step fails, fix it and add a follow-up task above.

---

## Task 8: Push and open PR

- [ ] **Step 1: Set `CRON_SECRET` in Vercel project env — BEFORE pushing**

The cron won't run until this is present. Go to Vercel Dashboard → Project `grocery-planner` → Settings → Environment Variables. Add `CRON_SECRET` with a random value for **Production, Preview, and Development**. Use `openssl rand -hex 32` for the value.

Verify with the Vercel CLI:

```bash
vercel env ls
```

Expected: `CRON_SECRET` listed for all three environments.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin week-5b-cron-refresh
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "Week 5b — Vercel Cron weekly refresh" --body "$(cat <<'EOF'
## Summary
- New `GET /api/jobs/weekly-refresh` Vercel Cron endpoint (Sunday 10:00 UTC via `vercel.json`), auth-gated by `Authorization: Bearer $CRON_SECRET`.
- New `lib/ingestion/refresh.ts` with a shared `refreshRetailer(name)` helper that never throws and correctly flips `retailer_health` to FAILED on error (preserving previous `last_success_at`).
- Existing admin endpoints (`/api/admin/refresh-ht`, `/api/admin/refresh-sprouts`) refactored onto the same helper so single-retailer and cron-driven refreshes share one code path.
- Middleware refactored to export a testable `isPublicPath()` and add the cron path to the bypass list.

## Test plan
- [x] `npm test -- --run` green (152 total; 4 new in `tests/ingestion/refresh.test.ts`, 3 new in `tests/middleware.test.ts`).
- [x] `npx tsc --noEmit` — no new errors.
- [x] Dev smoke: 401 without/with-wrong bearer, 200 with correct bearer, sensible JSON summary.

## Follow-ups (not in this PR)
- `CRON_SECRET` must be set in Vercel project env (Production + Preview + Development) before merge.
- Week 5c will add a `refresh_runs` audit table + Health Dashboard.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for Vercel preview + verify cron shows in the dashboard**

Wait for the Vercel preview deploy to reach "Ready" (~1 min). Then in Vercel Dashboard → Project → Cron Jobs, confirm:
- `/api/jobs/weekly-refresh` is listed
- Schedule shows `0 10 * * 0`
- Next-run timestamp is a future Sunday at 10:00 UTC

- [ ] **Step 5: Smoke test the preview URL**

```bash
PREVIEW=<paste preview URL>
curl -s -o /dev/null -w "%{http_code}\n" $PREVIEW/api/jobs/weekly-refresh
# Expected: 401

# Grab the preview's CRON_SECRET from Vercel (Preview env value):
vercel env pull .env.preview --environment=preview
PREVIEW_SECRET=$(grep '^CRON_SECRET=' .env.preview | cut -d= -f2 | tr -d '"')
curl -s -H "Authorization: Bearer $PREVIEW_SECRET" $PREVIEW/api/jobs/weekly-refresh | jq
# Expected: 200 with results/mapper JSON.

rm .env.preview
```

If green, merge.

- [ ] **Step 6: Merge and clean up**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull --ff-only
```

If `git pull --ff-only` fails because local `main` has diverging commits (as happened on 5a), stop and investigate — the spec + plan commits should already be inside the squash commit, so `git reset --hard origin/main` is safe after confirming with `git log --oneline main` and `git log --oneline origin/main`.

- [ ] **Step 7: Verify production**

- In Vercel Dashboard → Cron Jobs, confirm the production entry shows and the next-run timestamp is a future Sunday at 10:00 UTC.
- The following Sunday, check the Vercel run log for a successful invocation.
- Query the Supabase Dashboard:
  ```sql
  select r.name, h.last_success_at, h.last_status
  from retailer_health h join retailers r on r.id = h.retailer_id;
  ```
  Expected: both retailers show `last_status = 'OK'` with a `last_success_at` timestamp close to Sunday 10:00 UTC.

Done. Week 5b shipped.

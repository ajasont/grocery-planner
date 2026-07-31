# Week 5c — Health Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/health` page + banner on `/plan` so we notice when Sunday's cron fails or goes stale.

**Architecture:** New `job_runs` table persists mapper-run history. Pure `computeHealth()` reads `retailer_health` + `job_runs` and returns a `HealthSnapshot` consumed by both `/health` (dashboard) and `/plan` (inline banner). Retry buttons on `/health` POST to the existing admin refresh routes, which grow Accept-header branching to redirect browsers back to `/health` while still returning JSON to curl/tests.

**Tech Stack:** Next.js 14 App Router (Server Components), Supabase Postgres, Vitest with `vi.mock` (same idiom used across the repo).

**Spec:** `docs/superpowers/specs/2026-07-31-week-5c-health-dashboard-design.md`

**Branch:** `week-5c-health-dashboard` (already created)

---

## File Structure

**New files:**
- `supabase/migrations/0003_job_runs.sql` — table + index
- `lib/health/status.ts` — `computeHealth()`, `HealthSnapshot`, `STALE_THRESHOLD_MS`, display-name map
- `tests/health/status.test.ts` — status helper tests
- `tests/api/weekly-refresh.test.ts` — cron route tests (insert row, surface `failed`)
- `tests/api/admin-refresh.test.ts` — Accept-header branching tests
- `app/health/page.tsx` — dashboard Server Component
- `app/plan/HealthBanner.tsx` — banner component

**Modified files:**
- `lib/db/types.ts` — add `JobRun` type, extend `Tables` map
- `app/api/jobs/weekly-refresh/route.ts` — include `failed` in mapper response, insert `job_runs` row
- `app/api/admin/refresh-ht/route.ts` — Accept-header branching
- `app/api/admin/refresh-sprouts/route.ts` — Accept-header branching
- `app/plan/page.tsx` — call `computeHealth()`, render banner when `hasProblem`
- `app/pantry/page.tsx` — add "Health" link to nav row
- `app/plan/shopping-list/page.tsx` — add "Health" link to nav row

---

## Task 0: Preflight

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch and clean tree**

Run: `git branch --show-current && git status`
Expected: `week-5c-health-dashboard`, working tree clean.

- [ ] **Step 2: Baseline test run**

Run: `npm test`
Expected: all suites pass (baseline was 152 after 5b). Note the count as your regression floor.

- [ ] **Step 3: Baseline typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify remote Supabase is at migration 0002**

Open the Supabase SQL editor and run:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

Expected: includes `shopping_list_checks` (from 0002) but NOT `job_runs`. If `job_runs` already exists, stop and coordinate with the user before continuing.

---

## Task 1: Migration + `JobRun` type

**Files:**
- Create: `supabase/migrations/0003_job_runs.sql`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/0003_job_runs.sql`:

```sql
-- 0003_job_runs.sql
-- Per-run mapper stats from the weekly refresh cron.
-- One row per /api/jobs/weekly-refresh execution.
-- Retailer state stays in retailer_health (upsert-only) — this table is
-- append-only history for the mapper step, which was previously ephemeral.
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

- [ ] **Step 2: Apply the migration in the Supabase SQL editor**

Paste the contents of `0003_job_runs.sql` into the Supabase SQL editor and run. Verify success message. Then run:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'job_runs'
order by ordinal_position;
```

Expected: 7 rows with the columns declared above; `run_at`, `mapper_status`, `mapper_mapped`, `mapper_skipped`, `mapper_failed` are `NOT NULL`; `mapper_error` is nullable.

- [ ] **Step 3: Add `JobRun` type to `lib/db/types.ts`**

Insert this type after `RetailerHealth` and before `Tables`:

```typescript
export type JobRun = {
  id: number;
  run_at: string;              // ISO timestamp
  mapper_status: 'OK' | 'FAILED';
  mapper_mapped: number;
  mapper_skipped: number;
  mapper_failed: number;
  mapper_error: string | null;
};
```

Then extend the `Tables` map to include it:

```typescript
export type Tables = {
  retailers: Retailer;
  stores: Store;
  canonical_ingredients: CanonicalIngredient;
  retailer_skus: RetailerSku;
  deals: Deal;
  retailer_health: RetailerHealth;
  job_runs: JobRun;
};
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0003_job_runs.sql lib/db/types.ts
git commit -m "Add job_runs table + JobRun type (Week 5c)"
```

---

## Task 2: `computeHealth()` — status helper (TDD)

**Files:**
- Create: `lib/health/status.ts`
- Create: `tests/health/status.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/health/status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase — computeHealth reads retailer_health (joined with retailers) and job_runs.
const retailerHealthRowsSpy = vi.fn<() => Promise<{ data: unknown[]; error: null }>>(
  async () => ({ data: [], error: null })
);
const jobRunsRowsSpy = vi.fn<() => Promise<{ data: unknown[]; error: null }>>(
  async () => ({ data: [], error: null })
);

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'retailer_health') {
        return {
          select: () => ({
            // Chainable: no filter, returns all rows via `then` on the builder.
            // In real code we call select then await — the mock resolves immediately.
            then: (resolve: (v: unknown) => unknown) =>
              retailerHealthRowsSpy().then(resolve),
          }),
        };
      }
      if (table === 'job_runs') {
        return {
          select: () => ({
            order: () => ({
              limit: () => ({
                then: (resolve: (v: unknown) => unknown) =>
                  jobRunsRowsSpy().then(resolve),
              }),
            }),
          }),
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { computeHealth, STALE_THRESHOLD_MS } from '@/lib/health/status';

beforeEach(() => {
  vi.useRealTimers();
  retailerHealthRowsSpy.mockReset().mockResolvedValue({ data: [], error: null });
  jobRunsRowsSpy.mockReset().mockResolvedValue({ data: [], error: null });
});

function retailerHealthRow(
  name: 'harris-teeter' | 'sprouts',
  status: 'OK' | 'FAILED' | null,
  lastSuccessAt: string | null,
  lastError: string | null = null
) {
  return {
    last_success_at: lastSuccessAt,
    last_status: status,
    last_error: lastError,
    retailers: { name },
  };
}

function jobRunRow(
  runAt: string,
  status: 'OK' | 'FAILED',
  counts: { mapped: number; skipped: number; failed: number },
  error: string | null = null
) {
  return {
    run_at: runAt,
    mapper_status: status,
    mapper_mapped: counts.mapped,
    mapper_skipped: counts.skipped,
    mapper_failed: counts.failed,
    mapper_error: error,
  };
}

describe('STALE_THRESHOLD_MS', () => {
  it('is 8 days in milliseconds', () => {
    expect(STALE_THRESHOLD_MS).toBe(8 * 24 * 60 * 60 * 1000);
  });
});

describe('computeHealth — hasProblem', () => {
  it('is false when all retailers OK and latest mapper OK', async () => {
    const now = new Date('2026-08-03T10:00:00.000Z');
    vi.setSystemTime(now);
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-02T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-02T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRow('2026-08-02T14:10:00.000Z', 'OK', { mapped: 150, skipped: 10, failed: 0 }),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.hasProblem).toBe(false);
    expect(health.retailers).toHaveLength(2);
    expect(health.retailers.every((r) => r.status === 'OK')).toBe(true);
    expect(health.mapper?.status).toBe('OK');
  });

  it('is true when one retailer FAILED', async () => {
    const now = new Date('2026-08-03T10:00:00.000Z');
    vi.setSystemTime(now);
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-02T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'FAILED', '2026-07-26T14:07:00.000Z', 'Sprouts unreachable'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRow('2026-08-02T14:10:00.000Z', 'OK', { mapped: 100, skipped: 5, failed: 0 }),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.hasProblem).toBe(true);
    const sprouts = health.retailers.find((r) => r.name === 'sprouts');
    expect(sprouts?.status).toBe('FAILED');
    expect(sprouts?.lastError).toBe('Sprouts unreachable');
  });

  it('is true when mapper FAILED but retailers OK', async () => {
    const now = new Date('2026-08-03T10:00:00.000Z');
    vi.setSystemTime(now);
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-02T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-02T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRow('2026-08-02T14:10:00.000Z', 'FAILED', { mapped: 0, skipped: 0, failed: 0 }, 'Anthropic timeout'),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.hasProblem).toBe(true);
    expect(health.mapper?.status).toBe('FAILED');
    expect(health.mapper?.error).toBe('Anthropic timeout');
  });
});

describe('computeHealth — staleness', () => {
  it('marks a retailer STALE when last_success_at is 9 days ago and status is OK', async () => {
    const now = new Date('2026-08-03T10:00:00.000Z');
    vi.setSystemTime(now);
    const nineDaysAgo = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString();
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', nineDaysAgo),
        retailerHealthRow('sprouts', 'OK', now.toISOString()),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.hasProblem).toBe(true);
    const ht = health.retailers.find((r) => r.name === 'harris-teeter');
    expect(ht?.status).toBe('STALE');
  });

  it('boundary: exactly 8 days ago is OK, 8 days + 1 minute is STALE', async () => {
    const now = new Date('2026-08-03T10:00:00.000Z');
    vi.setSystemTime(now);
    const eightDays = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const eightDaysAndAMinute = new Date(
      now.getTime() - (8 * 24 * 60 * 60 * 1000 + 60 * 1000)
    ).toISOString();

    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', eightDays),
        retailerHealthRow('sprouts', 'OK', eightDaysAndAMinute),
      ],
      error: null,
    });

    const health = await computeHealth();

    const ht = health.retailers.find((r) => r.name === 'harris-teeter');
    const sprouts = health.retailers.find((r) => r.name === 'sprouts');
    expect(ht?.status).toBe('OK');
    expect(sprouts?.status).toBe('STALE');
  });

  it('marks a retailer NEVER when no retailer_health row exists', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', new Date().toISOString()),
        // No row for sprouts.
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.hasProblem).toBe(true);
    const sprouts = health.retailers.find((r) => r.name === 'sprouts');
    expect(sprouts?.status).toBe('NEVER');
    expect(sprouts?.lastSuccessAt).toBeNull();
  });

  it('marks FAILED when status is FAILED and last_success_at is null (never succeeded)', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'FAILED', null, 'first-run failure'),
        retailerHealthRow('sprouts', 'OK', new Date().toISOString()),
      ],
      error: null,
    });

    const health = await computeHealth();

    const ht = health.retailers.find((r) => r.name === 'harris-teeter');
    expect(ht?.status).toBe('FAILED');
  });

  it('marks STALE (not OK) when status is OK but last_success_at is null (defensive)', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', null),
        retailerHealthRow('sprouts', 'OK', new Date().toISOString()),
      ],
      error: null,
    });

    const health = await computeHealth();

    const ht = health.retailers.find((r) => r.name === 'harris-teeter');
    expect(ht?.status).toBe('STALE');
  });
});

describe('computeHealth — mapper and history split', () => {
  it('puts the newest job_run in `mapper` and the next 4 in `history`', async () => {
    // Return 5 rows so the split is observable.
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRow('2026-08-02T14:10:00.000Z', 'OK', { mapped: 100, skipped: 5, failed: 0 }),
        jobRunRow('2026-07-26T14:10:00.000Z', 'OK', { mapped: 98, skipped: 6, failed: 0 }),
        jobRunRow('2026-07-19T14:10:00.000Z', 'OK', { mapped: 90, skipped: 8, failed: 0 }),
        jobRunRow('2026-07-12T14:10:00.000Z', 'FAILED', { mapped: 0, skipped: 0, failed: 0 }, 'boom'),
        jobRunRow('2026-07-05T14:10:00.000Z', 'OK', { mapped: 85, skipped: 5, failed: 0 }),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.mapper?.runAt).toBe('2026-08-02T14:10:00.000Z');
    expect(health.history).toHaveLength(4);
    expect(health.history[0].runAt).toBe('2026-07-26T14:10:00.000Z');
    expect(health.history[3].runAt).toBe('2026-07-05T14:10:00.000Z');
  });

  it('returns mapper: null and history: [] when there are no job_runs yet', async () => {
    // First-ever state: retailer_health has rows but job_runs is empty.
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', new Date().toISOString()),
        retailerHealthRow('sprouts', 'OK', new Date().toISOString()),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.mapper).toBeNull();
    expect(health.history).toEqual([]);
    // No mapper history is not itself a problem — retailers can be OK.
    expect(health.hasProblem).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/health/status.test.ts`
Expected: FAIL — `Cannot find module '@/lib/health/status'`.

- [ ] **Step 3: Implement the status helper**

Create `lib/health/status.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';
// Type-only import: at runtime the refresh module (and its retailer fetchers)
// does not execute, so status tests don't need to mock those modules.
import type { RefreshRetailerName } from '@/lib/ingestion/refresh';

export const STALE_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;

const DISPLAY_NAMES: Record<RefreshRetailerName, string> = {
  'harris-teeter': 'Harris Teeter',
  sprouts: 'Sprouts',
};

const RETAILER_ORDER: RefreshRetailerName[] = ['harris-teeter', 'sprouts'];

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
};

export type HealthSnapshot = {
  hasProblem: boolean;
  retailers: RetailerStatus[];
  mapper: MapperStatus | null;
  history: MapperStatus[];
};

type RetailerHealthJoinRow = {
  last_success_at: string | null;
  last_status: 'OK' | 'FAILED' | 'DEGRADED' | null;
  last_error: string | null;
  retailers: { name: string } | null;
};

type JobRunRow = {
  run_at: string;
  mapper_status: 'OK' | 'FAILED';
  mapper_mapped: number;
  mapper_skipped: number;
  mapper_failed: number;
  mapper_error: string | null;
};

function classifyRetailer(
  name: RefreshRetailerName,
  row: RetailerHealthJoinRow | undefined,
  now: number
): RetailerStatus {
  if (!row) {
    return {
      name,
      displayName: DISPLAY_NAMES[name],
      status: 'NEVER',
      lastSuccessAt: null,
      lastError: null,
    };
  }
  const lastSuccessAt = row.last_success_at;
  const lastStatus = row.last_status;
  let status: RetailerHealthStatus;
  if (lastStatus === 'FAILED') {
    status = 'FAILED';
  } else if (lastSuccessAt === null) {
    // OK/DEGRADED/null status but no timestamp — treat as STALE.
    status = 'STALE';
  } else {
    const ageMs = now - new Date(lastSuccessAt).getTime();
    status = ageMs > STALE_THRESHOLD_MS ? 'STALE' : 'OK';
  }
  return {
    name,
    displayName: DISPLAY_NAMES[name],
    status,
    lastSuccessAt,
    lastError: row.last_error,
  };
}

function toMapperStatus(row: JobRunRow): MapperStatus {
  return {
    runAt: row.run_at,
    status: row.mapper_status,
    mapped: row.mapper_mapped,
    skipped: row.mapper_skipped,
    failed: row.mapper_failed,
    error: row.mapper_error,
  };
}

export async function computeHealth(): Promise<HealthSnapshot> {
  const supabase = getServerClient();

  // Read retailer_health joined with retailers so we get the retailer name inline.
  // Supabase-js JOIN syntax: select('col, ..., retailers(name)').
  const healthRes = (await supabase
    .from('retailer_health')
    .select(
      'last_success_at, last_status, last_error, retailers ( name )'
    )) as { data: RetailerHealthJoinRow[] | null; error: unknown };
  if (healthRes.error) throw healthRes.error;
  const healthRows = healthRes.data ?? [];

  // Read the newest 5 job_runs; the top row is `mapper`, next 4 are `history`.
  const jobRunsRes = (await supabase
    .from('job_runs')
    .select(
      'run_at, mapper_status, mapper_mapped, mapper_skipped, mapper_failed, mapper_error'
    )
    .order('run_at', { ascending: false })
    .limit(5)) as { data: JobRunRow[] | null; error: unknown };
  if (jobRunsRes.error) throw jobRunsRes.error;
  const jobRunRows = jobRunsRes.data ?? [];

  const byName = new Map<string, RetailerHealthJoinRow>();
  for (const r of healthRows) {
    const n = r.retailers?.name;
    if (n) byName.set(n, r);
  }

  const now = Date.now();
  const retailers = RETAILER_ORDER.map((name) =>
    classifyRetailer(name, byName.get(name), now)
  );

  const mapper = jobRunRows.length > 0 ? toMapperStatus(jobRunRows[0]) : null;
  const history = jobRunRows.slice(1).map(toMapperStatus);

  const hasProblem =
    retailers.some((r) => r.status !== 'OK') ||
    (mapper !== null && mapper.status === 'FAILED');

  return { hasProblem, retailers, mapper, history };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/health/status.test.ts`
Expected: all 10 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/health/status.ts tests/health/status.test.ts
git commit -m "Add computeHealth() with staleness and mapper history"
```

---

## Task 3: Cron route — insert `job_runs`, surface `failed`

**Files:**
- Modify: `app/api/jobs/weekly-refresh/route.ts`
- Create: `tests/api/weekly-refresh.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/weekly-refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockRefresh = vi.fn();
vi.mock('@/lib/ingestion/refresh', () => ({
  refreshRetailer: (name: string) => mockRefresh(name),
}));

const mockRunMapping = vi.fn();
vi.mock('@/lib/normalization/runner', () => ({
  runMappingForUnmappedSkus: () => mockRunMapping(),
}));

const jobRunsInsertSpy = vi.fn<
  (row: unknown) => Promise<{ error: { message: string } | null }>
>(async () => ({ error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'job_runs') {
        return { insert: jobRunsInsertSpy };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { GET } from '@/app/api/jobs/weekly-refresh/route';

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  mockRefresh.mockReset();
  mockRunMapping.mockReset();
  jobRunsInsertSpy.mockClear().mockResolvedValue({ error: null });
});

function authorizedReq(): NextRequest {
  return new NextRequest('https://example.test/api/jobs/weekly-refresh', {
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('weekly-refresh route — 401 on bad auth', () => {
  it('returns 401 without a bearer token', async () => {
    const req = new NextRequest('https://example.test/api/jobs/weekly-refresh');
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(jobRunsInsertSpy).not.toHaveBeenCalled();
  });
});

describe('weekly-refresh route — job_runs insert', () => {
  it('inserts an OK row when the mapper succeeds', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    mockRunMapping.mockResolvedValueOnce({ mapped: 12, skipped: 3, failed: 1 });

    const res = await GET(authorizedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mapper).toEqual({ mapped: 12, skipped: 3, failed: 1, error: null });
    expect(jobRunsInsertSpy).toHaveBeenCalledTimes(1);
    expect(jobRunsInsertSpy).toHaveBeenCalledWith({
      mapper_status: 'OK',
      mapper_mapped: 12,
      mapper_skipped: 3,
      mapper_failed: 1,
      mapper_error: null,
    });
  });

  it('inserts a FAILED row when the mapper throws', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    mockRunMapping.mockRejectedValueOnce(new Error('Anthropic 503'));

    const res = await GET(authorizedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mapper.error).toBe('Anthropic 503');
    expect(jobRunsInsertSpy).toHaveBeenCalledWith({
      mapper_status: 'FAILED',
      mapper_mapped: 0,
      mapper_skipped: 0,
      mapper_failed: 0,
      mapper_error: 'Anthropic 503',
    });
  });

  it('still returns 200 when the job_runs insert itself errors', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 1,
      dealsUpserted: 1,
      error: null,
    });
    mockRunMapping.mockResolvedValueOnce({ mapped: 5, skipped: 0, failed: 0 });
    jobRunsInsertSpy.mockResolvedValueOnce({ error: { message: 'DB down' } });

    const res = await GET(authorizedReq());
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/weekly-refresh.test.ts`
Expected: FAIL — either `body.mapper.failed` is undefined (route currently drops `failed`) or `jobRunsInsertSpy` was never called.

- [ ] **Step 3: Modify the cron route**

Replace the contents of `app/api/jobs/weekly-refresh/route.ts` with:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer, type RefreshResult } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';
import { getServerClient } from '@/lib/db/client';

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

  let mapper: {
    mapped: number;
    skipped: number;
    failed: number;
    error: string | null;
  };
  try {
    const m = await runMappingForUnmappedSkus();
    mapper = { mapped: m.mapped, skipped: m.skipped, failed: m.failed, error: null };
  } catch (err) {
    mapper = {
      mapped: 0,
      skipped: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort append to job_runs. A failed write here does not mask the
  // real result: the caller and Vercel logs still show the response envelope.
  try {
    const supabase = getServerClient();
    const { error } = await supabase.from('job_runs').insert({
      mapper_status: mapper.error === null ? 'OK' : 'FAILED',
      mapper_mapped: mapper.mapped,
      mapper_skipped: mapper.skipped,
      mapper_failed: mapper.failed,
      mapper_error: mapper.error,
    });
    if (error) {
      console.warn('job_runs insert failed:', error.message);
    }
  } catch (err) {
    console.warn(
      'job_runs insert threw:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return NextResponse.json({
    runAt: new Date().toISOString(),
    results,
    mapper,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/api/weekly-refresh.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/jobs/weekly-refresh/route.ts tests/api/weekly-refresh.test.ts
git commit -m "Cron: persist mapper runs to job_runs + surface failed count"
```

---

## Task 4: Admin routes — Accept-header branching (TDD)

**Files:**
- Modify: `app/api/admin/refresh-ht/route.ts`
- Modify: `app/api/admin/refresh-sprouts/route.ts`
- Create: `tests/api/admin-refresh.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/admin-refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockRefresh = vi.fn();
vi.mock('@/lib/ingestion/refresh', () => ({
  refreshRetailer: (name: string) => mockRefresh(name),
}));

const mockRunMapping = vi.fn();
vi.mock('@/lib/normalization/runner', () => ({
  runMappingForUnmappedSkus: () => mockRunMapping(),
}));

import { POST as postHt } from '@/app/api/admin/refresh-ht/route';
import { POST as postSprouts } from '@/app/api/admin/refresh-sprouts/route';

beforeEach(() => {
  mockRefresh.mockReset().mockResolvedValue({
    retailer: 'harris-teeter',
    status: 'OK',
    dealsFetched: 5,
    dealsUpserted: 5,
    error: null,
  });
  mockRunMapping.mockReset().mockResolvedValue({ mapped: 3, skipped: 1, failed: 0 });
});

describe('POST /api/admin/refresh-ht', () => {
  it('returns JSON when Accept: application/json is set', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    const res = await postHt(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.skusMapped).toBe(3);
    expect(body.skusSkipped).toBe(1);
  });

  it('303-redirects to /health when Accept is text/html (browser form)', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const res = await postHt(req);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://example.test/health');
  });

  it('303-redirects when Accept header is missing entirely', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
    });
    const res = await postHt(req);
    expect(res.status).toBe(303);
  });

  it('calls refreshRetailer with "harris-teeter"', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    await postHt(req);
    expect(mockRefresh).toHaveBeenCalledWith('harris-teeter');
  });
});

describe('POST /api/admin/refresh-sprouts', () => {
  it('calls refreshRetailer with "sprouts"', async () => {
    mockRefresh.mockResolvedValueOnce({
      retailer: 'sprouts',
      status: 'OK',
      dealsFetched: 2,
      dealsUpserted: 2,
      error: null,
    });
    const req = new NextRequest('https://example.test/api/admin/refresh-sprouts', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    await postSprouts(req);
    expect(mockRefresh).toHaveBeenCalledWith('sprouts');
  });

  it('303-redirects to /health when Accept is text/html', async () => {
    mockRefresh.mockResolvedValueOnce({
      retailer: 'sprouts',
      status: 'OK',
      dealsFetched: 2,
      dealsUpserted: 2,
      error: null,
    });
    const req = new NextRequest('https://example.test/api/admin/refresh-sprouts', {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    const res = await postSprouts(req);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://example.test/health');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/admin-refresh.test.ts`
Expected: FAIL — the routes currently take no `req` argument and always return JSON, so the 303 tests fail and the JSON-with-Accept test likely still passes.

- [ ] **Step 3: Update the HT admin route**

Replace `app/api/admin/refresh-ht/route.ts` with:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST(req: NextRequest) {
  const result = await refreshRetailer('harris-teeter');
  let mapping = { mapped: 0, skipped: 0 };
  let mapperError: string | null = null;
  try {
    const m = await runMappingForUnmappedSkus();
    mapping = { mapped: m.mapped, skipped: m.skipped };
  } catch (err) {
    mapperError = err instanceof Error ? err.message : String(err);
  }

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json')) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
      ...(mapperError !== null ? { mapperError } : {}),
    });
  }
  return NextResponse.redirect(new URL('/health', req.url), 303);
}
```

- [ ] **Step 4: Update the Sprouts admin route**

Replace `app/api/admin/refresh-sprouts/route.ts` with:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST(req: NextRequest) {
  const result = await refreshRetailer('sprouts');
  let mapping = { mapped: 0, skipped: 0 };
  let mapperError: string | null = null;
  try {
    const m = await runMappingForUnmappedSkus();
    mapping = { mapped: m.mapped, skipped: m.skipped };
  } catch (err) {
    mapperError = err instanceof Error ? err.message : String(err);
  }

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json')) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
      ...(mapperError !== null ? { mapperError } : {}),
    });
  }
  return NextResponse.redirect(new URL('/health', req.url), 303);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/api/admin-refresh.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/admin/refresh-ht/route.ts app/api/admin/refresh-sprouts/route.ts tests/api/admin-refresh.test.ts
git commit -m "Admin refresh routes: Accept-header branching (JSON vs 303 to /health)"
```

---

## Task 5: `HealthBanner` component

**Files:**
- Create: `app/plan/HealthBanner.tsx`

- [ ] **Step 1: Create the banner component**

Create `app/plan/HealthBanner.tsx`:

```tsx
import Link from 'next/link';
import type { HealthSnapshot } from '@/lib/health/status';


function bannerMessage(health: HealthSnapshot): string {
  const problemRetailers = health.retailers.filter((r) => r.status !== 'OK');
  const mapperFailed =
    health.mapper !== null && health.mapper.status === 'FAILED';

  const problemCount = problemRetailers.length + (mapperFailed ? 1 : 0);

  if (problemCount >= 2) {
    return 'Refresh problems detected';
  }

  if (problemRetailers.length === 1) {
    const r = problemRetailers[0];
    if (r.status === 'FAILED') {
      return `Sunday refresh failed for ${r.displayName}`;
    }
    if (r.status === 'STALE') {
      const days =
        r.lastSuccessAt !== null
          ? Math.floor(
              (Date.now() - new Date(r.lastSuccessAt).getTime()) /
                (24 * 60 * 60 * 1000)
            )
          : null;
      return days !== null
        ? `No refresh in ${days} days for ${r.displayName}`
        : `No refresh yet for ${r.displayName}`;
    }
    if (r.status === 'NEVER') {
      return `No refresh yet for ${r.displayName}`;
    }
  }

  if (mapperFailed) {
    return 'Ingredient mapping failed on last refresh';
  }

  return 'Refresh problem detected';
}

export function HealthBanner({ health }: { health: HealthSnapshot }) {
  const message = bannerMessage(health);
  return (
    <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p className="font-medium">
        {message} —{' '}
        <Link href="/health" className="underline hover:no-underline">
          view health
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/plan/HealthBanner.tsx
git commit -m "Add HealthBanner component with context-aware copy"
```

---

## Task 6: `/plan` page — integrate banner

**Files:**
- Modify: `app/plan/page.tsx`

- [ ] **Step 1: Import and call `computeHealth`, render banner**

Edit `app/plan/page.tsx`:

Add these imports at the top (after existing imports):

```typescript
import { computeHealth } from '@/lib/health/status';
import { HealthBanner } from './HealthBanner';
```

In the `PlanPage` function, replace:

```typescript
export default async function PlanPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const plan = await getCurrentWeekPlan();
  const errorKind = searchParams.error;
```

with:

```typescript
export default async function PlanPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const [plan, health] = await Promise.all([
    getCurrentWeekPlan(),
    computeHealth(),
  ]);
  const errorKind = searchParams.error;
```

In the `!plan` branch, add the banner above `{errorKind && ...}`:

```tsx
{health.hasProblem && <HealthBanner health={health} />}
{errorKind && <ErrorBanner kind={errorKind} />}
```

In the main return (after the header div, before `{errorKind && ...}`), do the same:

```tsx
{health.hasProblem && <HealthBanner health={health} />}
{errorKind && <ErrorBanner kind={errorKind} />}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/plan/page.tsx
git commit -m "Plan page: show HealthBanner when refresh has a problem"
```

---

## Task 7: `/health` page

**Files:**
- Create: `app/health/page.tsx`

- [ ] **Step 1: Create the dashboard page**

Create `app/health/page.tsx`:

```tsx
import Link from 'next/link';
import { computeHealth } from '@/lib/health/status';
import type { RetailerStatus, MapperStatus } from '@/lib/health/status';

export const dynamic = 'force-dynamic';

function fmtWhen(iso: string | null): string {
  if (iso === null) return 'never';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const hours = Math.round(diffMs / (60 * 60 * 1000));
  if (Math.abs(hours) < 48) return rtf.format(-hours, 'hour');
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  return rtf.format(-days, 'day');
}

function fmtRunAt(iso: string): string {
  // Locale-neutral compact form for the history table.
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
}

function statusColor(status: RetailerStatus['status']): string {
  switch (status) {
    case 'OK':
      return 'text-green-700';
    case 'STALE':
      return 'text-amber-700';
    case 'FAILED':
    case 'NEVER':
      return 'text-red-700';
  }
}

function retryAction(name: RetailerStatus['name']): string {
  return name === 'harris-teeter'
    ? '/api/admin/refresh-ht'
    : '/api/admin/refresh-sprouts';
}

function RetailerCard({ r }: { r: RetailerStatus }) {
  return (
    <div className="rounded border p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{r.displayName}</p>
          <p className={`text-sm ${statusColor(r.status)}`}>
            {r.status} — last success: {fmtWhen(r.lastSuccessAt)}
          </p>
          {r.lastError && (
            <p className="mt-1 text-xs text-red-700">Error: {r.lastError}</p>
          )}
        </div>
        <form action={retryAction(r.name)} method="POST">
          <button
            type="submit"
            className="rounded border px-3 py-1 text-sm hover:bg-neutral-50"
          >
            Retry
          </button>
        </form>
      </div>
    </div>
  );
}

function MapperCard({ m }: { m: MapperStatus }) {
  return (
    <div className="rounded border p-3">
      <p className="font-medium">Mapper — last run</p>
      <p className={`text-sm ${m.status === 'OK' ? 'text-green-700' : 'text-red-700'}`}>
        {fmtRunAt(m.runAt)} — {m.status} — {m.mapped} mapped / {m.skipped} skipped / {m.failed} failed
      </p>
      {m.error && <p className="mt-1 text-xs text-red-700">Error: {m.error}</p>}
    </div>
  );
}

export default async function HealthPage() {
  const health = await computeHealth();
  const overall = health.hasProblem ? 'Refresh problem detected' : 'All systems healthy';
  const overallClass = health.hasProblem
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-green-200 bg-green-50 text-green-700';

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
        <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
          Pantry →
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Health</h1>
        <div className={`mt-2 rounded border p-3 text-sm font-medium ${overallClass}`}>
          {overall}
        </div>
      </header>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Retailers</h2>
        <div className="space-y-2">
          {health.retailers.map((r) => (
            <RetailerCard key={r.name} r={r} />
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Mapper</h2>
        {health.mapper === null ? (
          <p className="text-sm text-neutral-500">
            No runs yet. First scheduled run: Sunday 14:00 UTC.
          </p>
        ) : (
          <MapperCard m={health.mapper} />
        )}
      </section>

      {health.history.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Recent runs</h2>
          <ul className="divide-y rounded border">
            {health.history.map((m) => (
              <li key={m.runAt} className="p-2 text-sm">
                <span className="font-mono text-neutral-500">{fmtRunAt(m.runAt)}</span>
                {' — '}
                <span className={m.status === 'OK' ? 'text-green-700' : 'text-red-700'}>
                  {m.status}
                </span>
                {' — '}
                {m.mapped} / {m.skipped} / {m.failed}
                {m.error && <span className="text-red-700"> — {m.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/health/page.tsx
git commit -m "Add /health dashboard page (retailers, mapper, history, retry)"
```

---

## Task 8: Navigation links to `/health`

**Files:**
- Modify: `app/plan/page.tsx`
- Modify: `app/pantry/page.tsx`
- Modify: `app/plan/shopping-list/page.tsx`

- [ ] **Step 1: Add Health link to `/plan`**

Edit `app/plan/page.tsx`. Two spots — the empty-state header and the filled-state header. In the empty-state block, the current header is:

```tsx
<div className="mb-4 flex items-center justify-between">
  <h2 className="text-lg font-semibold">This week&apos;s plan</h2>
  <Link href="/" className="text-sm text-neutral-500 hover:underline">
    ← Deals
  </Link>
</div>
```

Change to:

```tsx
<div className="mb-4 flex items-center justify-between">
  <h2 className="text-lg font-semibold">This week&apos;s plan</h2>
  <div className="flex items-center gap-3">
    <Link href="/health" className="text-sm text-neutral-500 hover:underline">
      Health
    </Link>
    <Link href="/" className="text-sm text-neutral-500 hover:underline">
      ← Deals
    </Link>
  </div>
</div>
```

In the filled-state block, the current right-side nav is:

```tsx
<div className="flex items-center gap-3">
  <RegenerateButton />
  <Link
    href="/plan/shopping-list"
    className="text-sm text-neutral-500 hover:underline"
  >
    Shopping list
  </Link>
  <Link href="/" className="text-sm text-neutral-500 hover:underline">
    ← Deals
  </Link>
</div>
```

Insert a Health link before "← Deals":

```tsx
<div className="flex items-center gap-3">
  <RegenerateButton />
  <Link
    href="/plan/shopping-list"
    className="text-sm text-neutral-500 hover:underline"
  >
    Shopping list
  </Link>
  <Link href="/health" className="text-sm text-neutral-500 hover:underline">
    Health
  </Link>
  <Link href="/" className="text-sm text-neutral-500 hover:underline">
    ← Deals
  </Link>
</div>
```

- [ ] **Step 2: Add Health link to `/pantry`**

Edit `app/pantry/page.tsx` — find the nav row block (should look like):

```tsx
<div className="mb-6">
  <Link href="/plan" className="text-sm text-blue-600 hover:underline">
    ← Back to plan
  </Link>
</div>
```

Change it to:

```tsx
<div className="mb-6 flex items-center justify-between">
  <Link href="/plan" className="text-sm text-blue-600 hover:underline">
    ← Back to plan
  </Link>
  <Link href="/health" className="text-sm text-blue-600 hover:underline">
    Health →
  </Link>
</div>
```

- [ ] **Step 3: Add Health link to `/plan/shopping-list`**

Edit `app/plan/shopping-list/page.tsx` — the existing nav row is:

```tsx
<div className="mb-6 flex items-center justify-between">
  <Link href="/plan" className="text-sm text-blue-600 hover:underline">
    ← Back to plan
  </Link>
  <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
    Pantry →
  </Link>
</div>
```

Replace with a three-item row:

```tsx
<div className="mb-6 flex items-center gap-4">
  <Link href="/plan" className="text-sm text-blue-600 hover:underline">
    ← Back to plan
  </Link>
  <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
    Pantry
  </Link>
  <Link href="/health" className="text-sm text-blue-600 hover:underline">
    Health
  </Link>
</div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/plan/page.tsx app/pantry/page.tsx app/plan/shopping-list/page.tsx
git commit -m "Add Health link to /plan, /pantry, /plan/shopping-list nav"
```

---

## Task 9: Full local verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: total test count = baseline from Task 0 + 20 (10 status + 4 weekly-refresh + 6 admin-refresh). All pass.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds. In the route manifest, verify:
- `ƒ /health` — Dynamic
- `ƒ /plan` — Dynamic (unchanged)
- `ƒ /api/jobs/weekly-refresh` — Dynamic (unchanged)
- `ƒ /api/admin/refresh-ht` — Dynamic (unchanged)
- `ƒ /api/admin/refresh-sprouts` — Dynamic (unchanged)

- [ ] **Step 4: Dev server smoke — golden path**

Start dev server in one terminal: `npm run dev`

In another terminal:

```bash
# 1. Verify /health renders empty-history state (or existing job_runs, if any)
curl -s -b "gp_session=<paste your session cookie value>" http://localhost:3000/health | grep -i "Health"
```

Expected: HTML output contains the "Health" heading and either "All systems healthy" or "Refresh problem detected".

Note: to get your session cookie, log in at http://localhost:3000/login in a browser and copy the `gp_session` cookie value from DevTools.

- [ ] **Step 5: Dev server smoke — job_runs insert path**

The `job_runs` insert lives in `/api/jobs/weekly-refresh` (the cron route), NOT in the admin retry routes. Trigger it directly:

```bash
CRON_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '"')
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/jobs/weekly-refresh
```

Expected: JSON with `runAt`, `results`, `mapper` (including `mapper.failed`). Then in the Supabase SQL editor:

```sql
select id, run_at, mapper_status, mapper_mapped, mapper_skipped, mapper_failed
from job_runs
order by run_at desc
limit 1;
```

Expected: one new row matching the response's mapper counts.

- [ ] **Step 6: Dev server smoke — banner appears on failure**

To verify the banner path, force a mapper failure by temporarily editing `.env.local` — set `ANTHROPIC_API_KEY=bad`, restart the dev server, POST to the cron route again. Then:

- Load `http://localhost:3000/health` — verify "Refresh problem detected" and a FAILED mapper row.
- Load `http://localhost:3000/plan` — verify red banner "Ingredient mapping failed on last refresh — view health".

Restore `ANTHROPIC_API_KEY` when done. Stop the dev server.

- [ ] **Step 7: Push the branch**

```bash
git push -u origin week-5c-health-dashboard
```

---

## Task 10: PR, Vercel verify, merge, prod verify

**Files:** none (deployment verification)

- [ ] **Step 1: Open a PR**

```bash
gh pr create --title "Week 5c — Health dashboard" --body "$(cat <<'EOF'
## Summary
- New `/health` page surfaces retailer refresh status, latest mapper run, and the last 4 runs' history
- Red banner on `/plan` when any retailer is FAILED/STALE or the last mapper run FAILED
- New `job_runs` table persists mapper stats per weekly-refresh execution
- Retry buttons on `/health` POST to existing admin routes; those routes now redirect back on browser POST and keep JSON for curl callers
- Cron response now includes the mapper's `failed` count (previously dropped)

## Test plan
- [ ] Preview build succeeds
- [ ] `/health` renders with existing data
- [ ] Manually POST to `/api/jobs/weekly-refresh` via curl (with `Authorization: Bearer $CRON_SECRET`); confirm a `job_runs` row appears
- [ ] Clicking Retry on `/health` returns to `/health` (not raw JSON)
- [ ] Following Sunday's cron writes another `job_runs` row and status stays OK

## Spec
`docs/superpowers/specs/2026-07-31-week-5c-health-dashboard-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for Vercel preview build**

Poll until Ready:

```bash
until vercel inspect "$(vercel ls grocery-planner 2>&1 | grep Preview | head -1 | awk '{print $4}')" 2>&1 | grep -qE "status.*(Ready|Error)"; do sleep 5; done
vercel ls grocery-planner 2>&1 | head -5
```

Expected: newest Preview shows `● Ready`.

- [ ] **Step 3: Smoke test the preview**

Pull preview env to grab `CRON_SECRET`:

```bash
vercel env pull .env.preview.local --environment=preview --yes
source .env.preview.local
```

Grab the preview URL from `vercel ls`:

```bash
PREVIEW_URL=$(vercel ls grocery-planner 2>&1 | grep Preview | head -1 | awk '{print $4}')
echo "Preview: $PREVIEW_URL"
```

Hit the cron endpoint:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "$PREVIEW_URL/api/jobs/weekly-refresh"
```

Expected: HTTP 200 with `{runAt, results, mapper}` shape. If retailers FAILED because Preview lacks `KROGER_CLIENT_ID` / Supabase vars, that's expected and matches Week 5b behavior — the response envelope proves the code path works.

Verify preview `/health` is behind auth:

```bash
curl -sI "$PREVIEW_URL/health"
```

Expected: 302/307 redirect to `/login` — proves middleware guards it.

Clean up: `rm -f .env.preview.local`.

- [ ] **Step 4: Merge the PR**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 5: Wait for production build**

```bash
until vercel inspect "$(vercel ls grocery-planner 2>&1 | grep Production | head -1 | awk '{print $4}')" 2>&1 | grep -qE "status.*(Ready|Error)"; do sleep 5; done
```

Expected: newest Production shows `● Ready`.

- [ ] **Step 6: Production spot-check**

In a browser, log in and visit `https://grocery-planner-omega.vercel.app/health`. Expected:
- "Health" heading renders
- Both retailer cards visible with real `last_success_at` from `retailer_health`
- Overall banner reflects current state (should be "All systems healthy" if the last real Sunday cron succeeded, or the appropriate problem message)

Optionally trigger a manual production refresh via the retry button on `/health` and verify a new `job_runs` row appears.

- [ ] **Step 7: Set a reminder to check next Sunday**

The next scheduled cron will fire at 14:00 UTC on the following Sunday. After it runs, verify:

```sql
-- In Supabase SQL editor
select run_at, mapper_status, mapper_mapped, mapper_skipped, mapper_failed, mapper_error
from job_runs
order by run_at desc
limit 3;

select r.name, rh.last_success_at, rh.last_status, rh.last_error
from retailer_health rh
join retailers r on r.id = rh.retailer_id;
```

Expected: a fresh `job_runs` row at ~14:00 UTC Sunday and both retailers with `last_status = 'OK'` and `last_success_at` matching.

---

## Rollback

If something goes wrong post-deploy:

- **Bad code**: revert the merge commit, force-push blocked on `main`, so open a revert PR:
  ```bash
  git revert -m 1 <merge-sha>
  git push origin main
  ```
- **Bad migration**: `drop table job_runs;` in Supabase SQL editor. This removes ~1-2 weeks of mapper history; retailer state is unaffected.

The migration is additive (no changes to existing tables or code paths that don't touch the new features), so a code revert without a migration rollback is also safe.

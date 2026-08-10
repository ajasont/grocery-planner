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

import {
  computeHealth,
  STALE_THRESHOLD_MS,
  MAPPER_HISTORY_STALE_MS,
} from '@/lib/health/status';

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
    // retailer_health has rows but job_runs is empty. Under the divergence-detection
    // semantics that's now a `mapperHistoryStale` signal (covered separately) — this
    // test focuses just on the shape of `mapper` and `history`.
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
  });

  it('degrades gracefully when the job_runs read fails (table missing, PostgREST error, etc.)', async () => {
    // retailer_health read succeeds — retailer statuses should still surface.
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', new Date().toISOString()),
        retailerHealthRow('sprouts', 'OK', new Date().toISOString()),
      ],
      error: null,
    });
    // job_runs read fails (simulates PGRST205 "table not found").
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: null as unknown as unknown[],
      error: { code: 'PGRST205', message: "Could not find the table 'public.job_runs' in the schema cache" },
    } as unknown as { data: unknown[]; error: null });

    // Should not throw — the page must still render.
    const health = await computeHealth();

    expect(health.mapper).toBeNull();
    expect(health.history).toEqual([]);
    expect(health.retailers).toHaveLength(2);
    expect(health.retailers.every((r) => r.status === 'OK')).toBe(true);
    // When job_runs is unreadable but retailer_health shows recent successes,
    // we've lost visibility to mapper history — surface it as a problem.
    expect(health.mapperHistoryStale).toBe(true);
    expect(health.hasProblem).toBe(true);
  });
});

describe('computeHealth — mapperHistoryStale (silent-failure detection)', () => {
  it('MAPPER_HISTORY_STALE_MS is one hour', () => {
    expect(MAPPER_HISTORY_STALE_MS).toBe(60 * 60 * 1000);
  });

  it('is false when both retailer_health and job_runs are empty (first-ever state)', async () => {
    // Defaults: both empty. Retailers will be NEVER (a separate problem signal),
    // but there's no divergence to detect yet.
    const health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(false);
  });

  it('is true when retailers have a recent success but job_runs is empty', async () => {
    // Real scenario: table was dropped, retailer_health survived, cron writes to job_runs silently no-op.
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', new Date().toISOString()),
        retailerHealthRow('sprouts', 'OK', new Date().toISOString()),
      ],
      error: null,
    });
    // job_runs stays empty.
    const health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(true);
    expect(health.hasProblem).toBe(true);
  });

  it('is false when retailer newest success matches job_runs newest run_at within threshold', async () => {
    const t = '2026-08-09T15:00:00.000Z';
    const t5s = '2026-08-09T15:00:05.000Z'; // 5s later — well within 1h threshold
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', t),
        retailerHealthRow('sprouts', 'OK', t5s),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [jobRunRow(t, 'OK', { mapped: 100, skipped: 5, failed: 0 })],
      error: null,
    });
    const health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(false);
    expect(health.hasProblem).toBe(false);
  });

  it('is true when retailer newest success is > 1h newer than newest job_runs (partial-failure divergence)', async () => {
    // Last week both wrote; this week only retailer_health wrote (job_runs insert failed silently).
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-09T15:00:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-09T14:59:47.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [jobRunRow('2026-08-02T14:10:00.000Z', 'OK', { mapped: 100, skipped: 5, failed: 0 })],
      error: null,
    });
    const health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(true);
    expect(health.hasProblem).toBe(true);
  });

  it('is false when job_runs is newer than any retailer_health (no partial-failure signal)', async () => {
    // Contrived: job_runs written but retailer_health wasn't updated this run. Retailer STALE surfaces separately.
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-02T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-02T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [jobRunRow('2026-08-09T14:10:00.000Z', 'OK', { mapped: 100, skipped: 5, failed: 0 })],
      error: null,
    });
    const health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(false);
  });

  it('boundary: exactly 1 hour later is OK, 1 hour + 1 minute is stale', async () => {
    const jobRunAt = '2026-08-09T14:00:00.000Z';
    const oneHourLater = '2026-08-09T15:00:00.000Z';
    const oneHourOneMinLater = '2026-08-09T15:01:00.000Z';

    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', oneHourLater),
        retailerHealthRow('sprouts', 'OK', oneHourLater),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [jobRunRow(jobRunAt, 'OK', { mapped: 100, skipped: 5, failed: 0 })],
      error: null,
    });
    let health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(false);

    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', oneHourOneMinLater),
        retailerHealthRow('sprouts', 'OK', oneHourOneMinLater),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [jobRunRow(jobRunAt, 'OK', { mapped: 100, skipped: 5, failed: 0 })],
      error: null,
    });
    health = await computeHealth();
    expect(health.mapperHistoryStale).toBe(true);
  });
});

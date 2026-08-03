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

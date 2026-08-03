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

  it('returns JSON (not redirect) when Accept header is missing (curl default)', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
    });
    const res = await postHt(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns JSON when Accept is */* (curl default)', async () => {
    const req = new NextRequest('https://example.test/api/admin/refresh-ht', {
      method: 'POST',
      headers: { accept: '*/*' },
    });
    const res = await postHt(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
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

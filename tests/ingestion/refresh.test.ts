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
const healthUpsertSpy = vi.fn<
  (row: unknown, opts: unknown) => Promise<{ error: { message: string } | null }>
>(async () => ({ error: null }));
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

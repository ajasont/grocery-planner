import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the mapper
const mockMap = vi.fn();
vi.mock('@/lib/normalization/mapper', () => ({
  mapProductNames: (names: string[]) => mockMap(names),
}));

// Mock the DB client
const mockUpdateEq = vi.fn(async () => ({ error: null }));
const mockUpdate = vi.fn((payload: unknown) => ({
  eq: (col: string, val: unknown) => mockUpdateEq(payload, col, val),
}));
const mockSelect = vi.fn();
vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'retailer_skus') {
        return {
          select: () => ({
            is: () => ({ eq: () => mockSelect() }),
          }),
          update: mockUpdate,
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

beforeEach(() => {
  mockMap.mockReset();
  mockUpdate.mockClear();
  mockUpdateEq.mockReset().mockResolvedValue({ error: null });
  mockSelect.mockReset();
});

describe('runMappingForUnmappedSkus', () => {
  it('maps unmapped SKUs and writes canonical_ingredient_id + confidence', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'Chicken Breast' },
        { id: 2, product_name: 'Baby Spinach' },
      ],
      error: null,
    });
    mockMap.mockResolvedValueOnce([
      { canonical_id: 'chicken_breast', confidence: 0.95 },
      { canonical_id: 'baby_spinach', confidence: 0.9 },
    ]);

    const result = await runMappingForUnmappedSkus();

    expect(mockMap).toHaveBeenCalledWith(['Chicken Breast', 'Baby Spinach']);
    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      { canonical_ingredient_id: 'chicken_breast', mapping_confidence: 0.95 },
      'id',
      1
    );
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      2,
      { canonical_ingredient_id: 'baby_spinach', mapping_confidence: 0.9 },
      'id',
      2
    );
    expect(result).toEqual({ mapped: 2, skipped: 0, failed: 0 });
  });

  it('skips rows where the mapper returned null canonical_id', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [{ id: 3, product_name: 'Mystery Item' }],
      error: null,
    });
    mockMap.mockResolvedValueOnce([{ canonical_id: null, confidence: 0.1 }]);

    const result = await runMappingForUnmappedSkus();

    expect(mockUpdateEq).not.toHaveBeenCalled();
    expect(result).toEqual({ mapped: 0, skipped: 1, failed: 0 });
  });

  it('returns 0/0 when no unmapped SKUs exist without calling the mapper', async () => {
    mockSelect.mockResolvedValueOnce({ data: [], error: null });

    const result = await runMappingForUnmappedSkus();

    expect(mockMap).not.toHaveBeenCalled();
    expect(mockUpdateEq).not.toHaveBeenCalled();
    expect(result).toEqual({ mapped: 0, skipped: 0, failed: 0 });
  });

  it('counts DB update failures without aborting the whole batch', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'Chicken Breast' },
        { id: 2, product_name: 'Baby Spinach' },
      ],
      error: null,
    });
    mockMap.mockResolvedValueOnce([
      { canonical_id: 'chicken_breast', confidence: 0.95 },
      { canonical_id: 'baby_spinach', confidence: 0.9 },
    ]);
    mockUpdateEq
      .mockResolvedValueOnce({ error: { message: 'fk violation' } })
      .mockResolvedValueOnce({ error: null });

    const result = await runMappingForUnmappedSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ mapped: 1, skipped: 0, failed: 1 });
  });
});

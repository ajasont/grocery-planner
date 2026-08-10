import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClassify = vi.fn();
vi.mock('@/lib/normalization/classifier', () => ({
  classifyProductNames: (names: string[]) => mockClassify(names),
}));

type UpdateEqResult = { error: { message: string } | null };
const mockUpdateEq = vi.fn<
  (payload: unknown, col: string, val: unknown) => Promise<UpdateEqResult>
>(async () => ({ error: null }));
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
            is: () => ({ like: () => mockSelect() }),
          }),
          update: mockUpdate,
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { runClassificationForUnclassifiedFlippSkus } from '@/lib/normalization/classifier-runner';

beforeEach(() => {
  mockClassify.mockReset();
  mockUpdate.mockClear();
  mockUpdateEq.mockReset().mockResolvedValue({ error: null });
  mockSelect.mockReset();
});

describe('runClassificationForUnclassifiedFlippSkus', () => {
  it('classifies unclassified Flipp SKUs and writes is_ingredient/confidence/reason', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'Boneless Chicken Breast', canonical_ingredient_id: null },
        { id: 2, product_name: 'Baby Spinach', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: true, confidence: 0.95, reason: 'meat' },
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockClassify).toHaveBeenCalledWith(['Boneless Chicken Breast', 'Baby Spinach']);
    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: true,
        classification_confidence: 0.95,
        classification_reason: 'meat',
      },
      'id',
      1
    );
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      2,
      {
        is_ingredient: true,
        classification_confidence: 0.9,
        classification_reason: 'produce',
      },
      'id',
      2
    );
    expect(result).toEqual({ classified: 2, flagged: 0, failed: 0 });
  });

  it('returns {0,0,0} when no unclassified SKUs exist without calling the classifier', async () => {
    mockSelect.mockResolvedValueOnce({ data: [], error: null });

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockUpdateEq).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 0, flagged: 0, failed: 0 });
  });

  it('cascade-clears canonical_ingredient_id and mapping_confidence when is_ingredient=false and a mapping exists', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        {
          id: 42,
          product_name: 'MADE-TO-ORDER SANDWICHES',
          canonical_ingredient_id: 'bread_sliced',
        },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: false, confidence: 0.9, reason: 'prepared deli item' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(1);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: false,
        classification_confidence: 0.9,
        classification_reason: 'prepared deli item',
        canonical_ingredient_id: null,
        mapping_confidence: null,
      },
      'id',
      42
    );
    expect(result).toEqual({ classified: 1, flagged: 1, failed: 0 });
  });

  it('skips cascade-clear when is_ingredient=false but no existing canonical mapping', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 7, product_name: 'Large Rose Bunches', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: false, confidence: 0.95, reason: 'floral' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(1);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: false,
        classification_confidence: 0.95,
        classification_reason: 'floral',
      },
      'id',
      7
    );
    expect(result).toEqual({ classified: 1, flagged: 1, failed: 0 });
  });

  it('counts DB update failures without aborting the batch', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'A', canonical_ingredient_id: null },
        { id: 2, product_name: 'B', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
    ]);
    mockUpdateEq
      .mockResolvedValueOnce({ error: { message: 'fk violation' } })
      .mockResolvedValueOnce({ error: null });

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ classified: 1, flagged: 0, failed: 1 });
  });

  it('propagates classifier throws', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [{ id: 1, product_name: 'A', canonical_ingredient_id: null }],
      error: null,
    });
    mockClassify.mockRejectedValueOnce(new Error('Anthropic 503'));

    await expect(runClassificationForUnclassifiedFlippSkus()).rejects.toThrow(
      /Anthropic 503/
    );
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });
});

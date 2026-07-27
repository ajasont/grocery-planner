import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK before importing the mapper.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

// Mock the canonical loader
vi.mock('@/lib/normalization/canonical', () => ({
  getCanonicalIngredients: vi.fn(async () => [
    { id: 'chicken_breast', name: 'Chicken Breast', category: 'meat' },
    { id: 'yellow_onion', name: 'Yellow Onion', category: 'produce' },
    { id: 'baby_spinach', name: 'Baby Spinach', category: 'produce' },
  ]),
}));

import { mapProductNames } from '@/lib/normalization/mapper';

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('mapProductNames', () => {
  it('returns one mapping per input name, in order', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [
              { index: 0, canonical_id: 'chicken_breast', confidence: 0.95 },
              { index: 1, canonical_id: 'baby_spinach', confidence: 0.9 },
            ],
          },
        },
      ],
    });

    const result = await mapProductNames([
      'Kroger Boneless Skinless Chicken Breast',
      'Organic Baby Spinach',
    ]);

    expect(result).toEqual([
      { canonical_id: 'chicken_breast', confidence: 0.95 },
      { canonical_id: 'baby_spinach', confidence: 0.9 },
    ]);
  });

  it('returns null canonical_id when Haiku returns "unknown"', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [{ index: 0, canonical_id: 'unknown', confidence: 0.2 }],
          },
        },
      ],
    });

    const result = await mapProductNames(['Weird Novelty Cheese Puff']);
    expect(result).toEqual([{ canonical_id: null, confidence: 0.2 }]);
  });

  it('fills gaps with null when Haiku omits an index', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [{ index: 0, canonical_id: 'chicken_breast', confidence: 0.9 }],
          },
        },
      ],
    });

    const result = await mapProductNames(['Chicken Breast', 'Missing Item']);
    expect(result[0]).toEqual({ canonical_id: 'chicken_breast', confidence: 0.9 });
    expect(result[1]).toEqual({ canonical_id: null, confidence: 0 });
  });

  it('batches inputs of 25 into two Haiku calls of 20 + 5', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'map_ingredients',
            input: {
              mappings: Array.from({ length: 20 }, (_, i) => ({
                index: i,
                canonical_id: 'chicken_breast',
                confidence: 0.9,
              })),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'map_ingredients',
            input: {
              mappings: Array.from({ length: 5 }, (_, i) => ({
                index: i,
                canonical_id: 'yellow_onion',
                confidence: 0.85,
              })),
            },
          },
        ],
      });

    const names = Array.from({ length: 25 }, (_, i) => `Item ${i}`);
    const result = await mapProductNames(names);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(25);
    expect(result[0].canonical_id).toBe('chicken_breast');
    expect(result[24].canonical_id).toBe('yellow_onion');
  });

  it('returns [] for empty input without calling Haiku', async () => {
    const result = await mapProductNames([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

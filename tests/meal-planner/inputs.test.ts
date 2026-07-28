import { describe, it, expect } from 'vitest';
import { cheapestByCanonical } from '@/lib/meal-planner/inputs';

type Row = Parameters<typeof cheapestByCanonical>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    canonical_id: 'chicken_breast',
    canonical_name: 'Chicken Breast',
    category: 'meat',
    retailer_name: 'harris-teeter',
    sale_price: 3.99,
    ...overrides,
  };
}

describe('cheapestByCanonical', () => {
  it('returns one row per canonical_id', () => {
    const result = cheapestByCanonical([
      row({ canonical_id: 'chicken_breast', sale_price: 3.99 }),
      row({ canonical_id: 'rice', canonical_name: 'Rice', sale_price: 1.5 }),
    ]);
    const ids = result.map((r) => r.canonical_id).sort();
    expect(ids).toEqual(['chicken_breast', 'rice']);
  });

  it('picks the min sale_price across retailers for a canonical', () => {
    const result = cheapestByCanonical([
      row({ retailer_name: 'harris-teeter', sale_price: 4.99 }),
      row({ retailer_name: 'sprouts', sale_price: 3.49 }),
      row({ retailer_name: 'target', sale_price: 5.99 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].cheapest_retailer).toBe('sprouts');
    expect(result[0].sale_price).toBe(3.49);
  });

  it('skips rows with null canonical_id or null sale_price', () => {
    const result = cheapestByCanonical([
      row({ canonical_id: null as unknown as string, sale_price: 1 }),
      row({ sale_price: null as unknown as number }),
      row({ canonical_id: 'rice', canonical_name: 'Rice', sale_price: 1.5 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].canonical_id).toBe('rice');
  });

  it('sorts output by canonical_name for stable prompts', () => {
    const result = cheapestByCanonical([
      row({ canonical_id: 'zucchini', canonical_name: 'Zucchini', sale_price: 1 }),
      row({ canonical_id: 'apple', canonical_name: 'Apple', sale_price: 1 }),
    ]);
    expect(result.map((r) => r.canonical_id)).toEqual(['apple', 'zucchini']);
  });
});

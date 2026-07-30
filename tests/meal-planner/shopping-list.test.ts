import { describe, it, expect } from 'vitest';
import {
  buildShoppingListFromRows,
  type ShoppingListInputs,
} from '@/lib/meal-planner/shopping-list';

function inputs(overrides: Partial<ShoppingListInputs> = {}): ShoppingListInputs {
  return {
    planId: 1,
    weekOf: '2026-07-27',
    pantryCanonicalIds: [],
    ingredients: [],
    deals: [],
    checkedCanonicalIds: new Set(),
    ...overrides,
  };
}

describe('buildShoppingListFromRows', () => {
  it('returns empty sections and zero totals for a plan with no ingredients', () => {
    const result = buildShoppingListFromRows(inputs());
    expect(result.planId).toBe(1);
    expect(result.weekOf).toBe('2026-07-27');
    expect(result.sections).toEqual([]);
    expect(result.grandTotalOnSale).toBe(0);
    expect(result.grandTotalAll).toBe(0);
  });

  it('produces one line per canonical_id, summing quantities when units match', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 0.5, unit: 'lb' },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    const item = result.sections[0].items[0];
    expect(item.canonicalId).toBe('chicken_breast');
    expect(item.quantity).toBe(1.5);
    expect(item.unit).toBe('lb');
  });

  it('drops the unit when occurrences use mixed units', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'rice', canonicalName: 'Rice', quantity: 2, unit: 'cup' },
          { canonicalId: 'rice', canonicalName: 'Rice', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const item = result.sections[0].items[0];
    expect(item.quantity).toBe(3);
    expect(item.unit).toBeNull();
  });

  it('excludes items whose canonical_id is in the pantry snapshot', () => {
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', quantity: 2, unit: 'tbsp' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const canonicals = result.sections.flatMap((s) => s.items.map((i) => i.canonicalId));
    expect(canonicals).toEqual(['chicken_breast']);
  });

  it('treats null quantity as 0 (skips it from the sum without crashing)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'salt', canonicalName: 'Salt', quantity: null, unit: null },
        ],
      })
    );
    const item = result.sections[0].items[0];
    expect(item.canonicalId).toBe('salt');
    expect(item.quantity).toBe(0);
  });

  it('picks the cheapest retailer per canonical from the deals rows', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'chicken_breast', retailerName: 'sprouts',       salePrice: 3.49, regularPrice: 6.49 },
          { canonicalId: 'chicken_breast', retailerName: 'target',        salePrice: 5.99, regularPrice: 6.99 },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('sprouts');
    expect(result.sections[0].items[0].salePrice).toBe(3.49);
    expect(result.sections[0].items[0].regularPrice).toBe(6.49);
  });

  it('buckets canonicals with a deal row but no sale_price into "Not on sale"', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'basmati_rice', canonicalName: 'Basmati Rice', quantity: 1, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'basmati_rice', retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('Not on sale');
    expect(result.sections[0].items[0].salePrice).toBeNull();
    expect(result.sections[0].items[0].regularPrice).toBe(3.99);
  });

  it('buckets canonicals with no deal row at all into "Not on sale" with null prices', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'saffron', canonicalName: 'Saffron', quantity: 1, unit: 'pinch' },
        ],
        deals: [],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('Not on sale');
    expect(result.sections[0].items[0].salePrice).toBeNull();
    expect(result.sections[0].items[0].regularPrice).toBeNull();
  });

  it('per-item cost uses ceil(quantity) * salePrice (0.5 lb of $6.99/lb rounds up to $6.99)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 0.5, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 6.99, regularPrice: 8.99 },
        ],
      })
    );
    expect(result.sections[0].subtotal).toBeCloseTo(6.99, 2);
    expect(result.grandTotalOnSale).toBeCloseTo(6.99, 2);
  });

  it('grandTotalAll adds non-sale items priced at regular_price to grandTotalOnSale', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'basmati_rice',   canonicalName: 'Basmati Rice',   quantity: 2, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'basmati_rice',   retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
        ],
      })
    );
    expect(result.grandTotalOnSale).toBeCloseTo(4.99, 2);
    expect(result.grandTotalAll).toBeCloseTo(4.99 + 2 * 3.99, 2);
  });

  it('sorts retailer sections by descending on-sale subtotal, with "Not on sale" always last', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'small_ht', canonicalName: 'Small HT', quantity: 1, unit: 'ea' },
          { canonicalId: 'big_sp',   canonicalName: 'Big SP',   quantity: 1, unit: 'ea' },
          { canonicalId: 'unmapped', canonicalName: 'Unmapped', quantity: 1, unit: 'ea' },
        ],
        deals: [
          { canonicalId: 'small_ht', retailerName: 'harris-teeter', salePrice: 1.00, regularPrice: 2.00 },
          { canonicalId: 'big_sp',   retailerName: 'sprouts',       salePrice: 9.99, regularPrice: 12.99 },
        ],
      })
    );
    const retailers = result.sections.map((s) => s.retailer);
    expect(retailers).toEqual(['sprouts', 'harris-teeter', 'Not on sale']);
  });

  it('sorts items alphabetically by name within a section', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'zucchini', canonicalName: 'Zucchini', quantity: 1, unit: 'ea' },
          { canonicalId: 'apple',    canonicalName: 'Apple',    quantity: 1, unit: 'ea' },
        ],
        deals: [
          { canonicalId: 'zucchini', retailerName: 'harris-teeter', salePrice: 1.99, regularPrice: 2.99 },
          { canonicalId: 'apple',    retailerName: 'harris-teeter', salePrice: 0.99, regularPrice: 1.49 },
        ],
      })
    );
    const names = result.sections[0].items.map((i) => i.name);
    expect(names).toEqual(['Apple', 'Zucchini']);
  });

  it('marks items with isChecked=true when their canonical is in checkedCanonicalIds', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'rice',           canonicalName: 'Rice',           quantity: 1, unit: 'cup' },
        ],
        checkedCanonicalIds: new Set(['chicken_breast']),
      })
    );
    const flat = result.sections.flatMap((s) => s.items);
    const chicken = flat.find((i) => i.canonicalId === 'chicken_breast');
    const rice = flat.find((i) => i.canonicalId === 'rice');
    expect(chicken?.isChecked).toBe(true);
    expect(rice?.isChecked).toBe(false);
  });
});

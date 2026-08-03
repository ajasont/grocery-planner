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

function ing(
  overrides: Partial<ShoppingListInputs['ingredients'][number]> = {}
): ShoppingListInputs['ingredients'][number] {
  return {
    canonicalId: 'x',
    canonicalName: 'X',
    shoppingGroup: null,
    quantity: 1,
    unit: 'lb',
    mealName: 'Meal',
    mealDay: 'Monday',
    ...overrides,
  };
}

function deal(
  overrides: Partial<ShoppingListInputs['deals'][number]> = {}
): ShoppingListInputs['deals'][number] {
  return {
    canonicalId: 'x',
    shoppingGroup: null,
    retailerName: 'Harris Teeter',
    salePrice: 1.99,
    regularPrice: 2.49,
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
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 0.5, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    const item = result.sections[0].items[0];
    expect(item.groupKey).toBe('chicken_breast');
    expect(item.quantity).toBe(1.5);
    expect(item.unit).toBe('lb');
  });

  it('drops the unit when occurrences use mixed units', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'rice', canonicalName: 'Rice', shoppingGroup: null, quantity: 2, unit: 'cup', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'rice', canonicalName: 'Rice', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
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
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', shoppingGroup: null, quantity: 2, unit: 'tbsp', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    const groupKeys = result.sections.flatMap((s) => s.items.map((i) => i.groupKey));
    expect(groupKeys).toEqual(['chicken_breast']);
  });

  it('treats null quantity as 0 (skips it from the sum without crashing)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'salt', canonicalName: 'Salt', shoppingGroup: null, quantity: null, unit: null, mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    const item = result.sections[0].items[0];
    expect(item.groupKey).toBe('salt');
    expect(item.quantity).toBe(0);
  });

  it('picks the cheapest retailer per canonical from the deals rows', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'sprouts',       salePrice: 3.49, regularPrice: 6.49 },
          { canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'target',        salePrice: 5.99, regularPrice: 6.99 },
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
          { canonicalId: 'basmati_rice', canonicalName: 'Basmati Rice', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'basmati_rice', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
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
          { canonicalId: 'saffron', canonicalName: 'Saffron', shoppingGroup: null, quantity: 1, unit: 'pinch', mealName: 'Meal', mealDay: 'Monday' },
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
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 0.5, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 6.99, regularPrice: 8.99 },
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
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'basmati_rice',   canonicalName: 'Basmati Rice',   shoppingGroup: null, quantity: 2, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'basmati_rice',   shoppingGroup: null, retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
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
          { canonicalId: 'small_ht', canonicalName: 'Small HT', shoppingGroup: null, quantity: 1, unit: 'ea', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'big_sp',   canonicalName: 'Big SP',   shoppingGroup: null, quantity: 1, unit: 'ea', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'unmapped', canonicalName: 'Unmapped', shoppingGroup: null, quantity: 1, unit: 'ea', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'small_ht', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 1.00, regularPrice: 2.00 },
          { canonicalId: 'big_sp',   shoppingGroup: null, retailerName: 'sprouts',       salePrice: 9.99, regularPrice: 12.99 },
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
          { canonicalId: 'zucchini', canonicalName: 'Zucchini', shoppingGroup: null, quantity: 1, unit: 'ea', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'apple',    canonicalName: 'Apple',    shoppingGroup: null, quantity: 1, unit: 'ea', mealName: 'Meal', mealDay: 'Monday' },
        ],
        deals: [
          { canonicalId: 'zucchini', shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 1.99, regularPrice: 2.99 },
          { canonicalId: 'apple',    shoppingGroup: null, retailerName: 'harris-teeter', salePrice: 0.99, regularPrice: 1.49 },
        ],
      })
    );
    const names = result.sections[0].items.map((i) => i.displayName);
    expect(names).toEqual(['Apple', 'Zucchini']);
  });

  it('marks items with isChecked=true when their canonical is in checkedCanonicalIds', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'rice',           canonicalName: 'Rice',           shoppingGroup: null, quantity: 1, unit: 'cup', mealName: 'Meal', mealDay: 'Monday' },
        ],
        checkedCanonicalIds: new Set(['chicken_breast']),
      })
    );
    const flat = result.sections.flatMap((s) => s.items);
    const chicken = flat.find((i) => i.groupKey === 'chicken_breast');
    const rice = flat.find((i) => i.groupKey === 'rice');
    expect(chicken?.isChecked).toBe(true);
    expect(rice?.isChecked).toBe(false);
  });

  it('excludes items whose canonical_id is in the live pantry union (not in snapshot)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        // Simulates the orchestrator having unioned snapshot + live pantry.
        pantryCanonicalIds: ['garlic'],
        ingredients: [
          { canonicalId: 'garlic', canonicalName: 'Garlic', shoppingGroup: null, quantity: 1, unit: 'head', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    const groupKeys = result.sections.flatMap((s) => s.items.map((i) => i.groupKey));
    expect(groupKeys).toEqual(['chicken_breast']);
  });

  it('deduplicates when the same canonical is in both snapshot and live pantry (no double effect)', () => {
    // Real orchestrator unions the two lists before passing them in. A canonical
    // appearing twice in the input should filter out exactly once — no crash, no double-count.
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil', 'olive_oil'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', shoppingGroup: null, quantity: 2, unit: 'tbsp', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    const groupKeys = result.sections.flatMap((s) => s.items.map((i) => i.groupKey));
    expect(groupKeys).toEqual(['chicken_breast']);
  });

  it('handles disjoint snapshot and live pantry canonicals — both filtered, third ingredient survives', () => {
    // Simulates snapshot exclude=[A], live pantry exclude=[B] merged by orchestrator into [A, B].
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil', 'garlic'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', shoppingGroup: null, quantity: 2, unit: 'tbsp', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'garlic', canonicalName: 'Garlic', shoppingGroup: null, quantity: 1, unit: 'head', mealName: 'Meal', mealDay: 'Monday' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 1, unit: 'lb', mealName: 'Meal', mealDay: 'Monday' },
        ],
      })
    );
    const groupKeys = result.sections.flatMap((s) => s.items.map((i) => i.groupKey));
    expect(groupKeys).toEqual(['chicken_breast']);
  });
});

describe('buildShoppingListFromRows — group rollup', () => {
  it('rolls two pasta shapes into a single "Pasta" row', () => {
    const list = buildShoppingListFromRows({
      planId: 1,
      weekOf: '2026-08-03',
      pantryCanonicalIds: [],
      checkedCanonicalIds: new Set(),
      ingredients: [
        ing({
          canonicalId: 'pasta_penne',
          canonicalName: 'Penne',
          shoppingGroup: 'pasta',
          quantity: 1,
          mealName: 'Vodka',
          mealDay: 'Wednesday',
        }),
        ing({
          canonicalId: 'pasta_rigatoni',
          canonicalName: 'Rigatoni',
          shoppingGroup: 'pasta',
          quantity: 1,
          mealName: 'Bolognese',
          mealDay: 'Monday',
        }),
      ],
      deals: [
        deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: 1.99, regularPrice: 2.49 }),
        deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', salePrice: 2.49, regularPrice: 2.99 }),
      ],
    });

    // One "Harris Teeter" section, one item (the rolled-up pasta).
    const section = list.sections.find((s) => s.retailer === 'Harris Teeter');
    expect(section, 'expected Harris Teeter section').toBeDefined();
    expect(section?.items).toHaveLength(1);

    const row = section!.items[0];
    expect(row.groupKey).toBe('pasta');
    expect(row.displayName).toBe('Pasta');
    expect(row.quantity).toBe(2);
    expect(row.memberCanonicalIdsInUse.sort()).toEqual(['pasta_penne', 'pasta_rigatoni']);
    expect(row.cheapestMemberCanonicalId).toBe('pasta_penne');
    expect(row.cheapestMemberDisplayName).toBe('Penne');
    expect(row.salePrice).toBe(1.99);

    // Subtotal = ceil(2) * 1.99 = 3.98.
    expect(section?.subtotal).toBeCloseTo(3.98, 2);
    expect(list.grandTotalOnSale).toBeCloseTo(3.98, 2);
  });
});

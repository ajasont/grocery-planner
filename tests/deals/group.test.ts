import { describe, it, expect } from 'vitest';
import { groupDeals, type GroupInput } from '@/lib/deals/group';

const row = (overrides: Partial<GroupInput>): GroupInput => ({
  sku_id: 1,
  retailer_name: 'harris-teeter',
  canonical_ingredient_id: null,
  canonical_name: null,
  product_name: 'Something',
  sale_price: 1.0,
  regular_price: 2.0,
  image_url: null,
  ...overrides,
});

describe('groupDeals', () => {
  it('collapses multiple SKUs mapped to the same canonical at the same retailer', () => {
    const rows = [
      row({
        sku_id: 1,
        canonical_ingredient_id: 'pasta',
        canonical_name: 'Pasta',
        product_name: 'HT Rigatoni',
        sale_price: 0.99,
        regular_price: 1.69,
      }),
      row({
        sku_id: 2,
        canonical_ingredient_id: 'pasta',
        canonical_name: 'Pasta',
        product_name: 'HT Penne',
        sale_price: 0.99,
        regular_price: 1.69,
      }),
      row({
        sku_id: 3,
        canonical_ingredient_id: 'pasta',
        canonical_name: 'Pasta',
        product_name: 'HT Spaghetti',
        sale_price: 0.99,
        regular_price: 1.69,
      }),
    ];

    const groups = groupDeals(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].variant_count).toBe(3);
    expect(groups[0].canonical_name).toBe('Pasta');
    expect(groups[0].sale_price).toBe(0.99);
    expect(groups[0].regular_price).toBe(1.69);
    expect(groups[0].retailer_name).toBe('harris-teeter');
  });

  it('keeps the same canonical at different retailers as separate groups', () => {
    const rows = [
      row({
        sku_id: 1,
        retailer_name: 'harris-teeter',
        canonical_ingredient_id: 'yogurt',
        canonical_name: 'Yogurt',
        sale_price: 1.25,
      }),
      row({
        sku_id: 2,
        retailer_name: 'sprouts',
        canonical_ingredient_id: 'yogurt',
        canonical_name: 'Yogurt',
        sale_price: 1.99,
      }),
    ];

    const groups = groupDeals(rows);

    expect(groups).toHaveLength(2);
    const retailers = groups.map((g) => g.retailer_name).sort();
    expect(retailers).toEqual(['harris-teeter', 'sprouts']);
  });

  it('leaves unmapped SKUs as singleton groups', () => {
    const rows = [
      row({ sku_id: 10, product_name: 'Large Rose Bunches', sale_price: 15.99 }),
      row({ sku_id: 11, product_name: 'Non-GMO Bulk Candy', sale_price: 7.99 }),
    ];

    const groups = groupDeals(rows);

    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.variant_count).toBe(1);
      expect(g.canonical_name).toBeNull();
    }
  });

  it('picks the min sale_price when variants differ and uses that rows regular_price and image', () => {
    const rows = [
      row({
        sku_id: 1,
        canonical_ingredient_id: 'apple',
        canonical_name: 'Apple',
        product_name: 'Fuji Apple',
        sale_price: 1.5,
        regular_price: 2.0,
        image_url: 'https://img/fuji.jpg',
      }),
      row({
        sku_id: 2,
        canonical_ingredient_id: 'apple',
        canonical_name: 'Apple',
        product_name: 'Gala Apple',
        sale_price: 0.99,
        regular_price: 1.79,
        image_url: 'https://img/gala.jpg',
      }),
    ];

    const groups = groupDeals(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].sale_price).toBe(0.99);
    expect(groups[0].regular_price).toBe(1.79);
    expect(groups[0].sample_image_url).toBe('https://img/gala.jpg');
    expect(groups[0].sample_product_name).toBe('Gala Apple');
  });

  it('sorts groups by sale_price ascending', () => {
    const rows = [
      row({ sku_id: 1, product_name: 'Expensive', sale_price: 9.99 }),
      row({ sku_id: 2, product_name: 'Cheap', sale_price: 0.99 }),
      row({ sku_id: 3, product_name: 'Middle', sale_price: 4.99 }),
    ];

    const groups = groupDeals(rows);

    expect(groups.map((g) => g.sale_price)).toEqual([0.99, 4.99, 9.99]);
  });

  it('caps groups per retailer when perRetailer is provided', () => {
    const rows: GroupInput[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ sku_id: i, retailer_name: 'harris-teeter', sale_price: i + 1 }));
    }
    for (let i = 0; i < 5; i++) {
      rows.push(row({ sku_id: 100 + i, retailer_name: 'sprouts', sale_price: i + 1 }));
    }

    const groups = groupDeals(rows, { perRetailer: 2 });

    const htCount = groups.filter((g) => g.retailer_name === 'harris-teeter').length;
    const sprCount = groups.filter((g) => g.retailer_name === 'sprouts').length;
    expect(htCount).toBe(2);
    expect(sprCount).toBe(2);
  });

  it('applies the per-retailer cap on cheapest groups first', () => {
    const rows: GroupInput[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(row({ sku_id: i, retailer_name: 'harris-teeter', sale_price: i + 1 }));
    }

    const groups = groupDeals(rows, { perRetailer: 2 });

    expect(groups.map((g) => g.sale_price)).toEqual([1, 2]);
  });
});

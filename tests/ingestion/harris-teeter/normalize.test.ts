import { describe, it, expect } from 'vitest';
import { normalizeKrogerProducts } from '@/lib/ingestion/harris-teeter/normalize';
import type { KrogerProduct } from '@/lib/ingestion/harris-teeter/products';

const chicken: KrogerProduct = {
  productId: '0001111041700',
  description: 'Kroger Boneless Skinless Chicken Breast',
  images: [{ sizes: [{ size: 'medium', url: 'https://img/chicken' }] }],
  items: [
    {
      itemId: '0001111041700',
      size: '1 lb',
      price: { regular: 4.99, promo: 3.49 },
      fulfillment: { instore: true },
    },
  ],
};

const spinach: KrogerProduct = {
  productId: '0002222055500',
  description: 'Organic Baby Spinach',
  images: [],
  items: [
    {
      itemId: '0002222055500',
      size: '5 oz',
      price: { regular: 3.99, promo: 0 },
      fulfillment: { instore: true },
    },
  ],
};

describe('normalizeKrogerProducts', () => {
  it('flags items with promo price as on_sale', () => {
    const [deal] = normalizeKrogerProducts([chicken], '09700123');
    expect(deal).toMatchObject({
      retailer: 'harris-teeter',
      store_number: '09700123',
      sku: '0001111041700',
      product_name: 'Kroger Boneless Skinless Chicken Breast',
      package_size: 1,
      package_unit: 'lb',
      image_url: 'https://img/chicken',
      regular_price: 4.99,
      sale_price: 3.49,
      on_sale: true,
      source: 'api',
    });
  });

  it('marks items without promo as not on sale', () => {
    const [deal] = normalizeKrogerProducts([spinach], '09700123');
    expect(deal.on_sale).toBe(false);
    expect(deal.sale_price).toBeNull();
    expect(deal.regular_price).toBe(3.99);
    expect(deal.package_size).toBe(5);
    expect(deal.package_unit).toBe('oz');
  });

  it('skips products with no items array or no first item', () => {
    const broken: KrogerProduct = { productId: 'x', description: 'y', items: [] };
    expect(normalizeKrogerProducts([broken], 's')).toHaveLength(0);
  });
});

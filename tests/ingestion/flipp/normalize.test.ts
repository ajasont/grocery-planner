import { describe, it, expect } from 'vitest';
import { normalizeFlippItems } from '@/lib/ingestion/flipp/normalize';
import type { FlippItem } from '@/lib/ingestion/flipp/types';

const base: FlippItem = {
  id: 100,
  flyer_item_id: 100,
  flyer_id: 8032364,
  merchant_id: 2419,
  merchant_name: 'Sprouts Farmers Market',
  name: 'Placeholder',
  item_type: 'flyer',
  current_price: null,
  original_price: null,
  pre_price_text: null,
  post_price_text: null,
  sale_story: null,
  valid_from: '2026-07-22T07:00:00+00:00',
  valid_to: '2026-07-29T03:59:59+00:00',
  clean_image_url: null,
  clipping_image_url: null,
};

describe('normalizeFlippItems', () => {
  it('converts a Flipp item with a concrete current_price', () => {
    const peaches: FlippItem = {
      ...base,
      flyer_item_id: 1026801989,
      name: 'Large Yellow or White Peaches',
      current_price: 1.98,
      post_price_text: '/LB.',
      clean_image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
      clipping_image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([peaches], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal).toMatchObject({
      retailer: 'sprouts',
      store_number: 'flipp-2419',
      sku: 'flipp-1026801989',
      product_name: 'Large Yellow or White Peaches',
      regular_price: null,
      sale_price: 1.98,
      on_sale: true,
      source: 'flipp',
      image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
    });
  });

  it('divides current_price by the quantity in "2 FOR" pre_price_text', () => {
    const iceCream: FlippItem = {
      ...base,
      flyer_item_id: 1026801888,
      name: 'CVT Soft Serve Ice Cream',
      current_price: 7,
      pre_price_text: '2 FOR',
      clipping_image_url: 'https://f.wishabi.net/page_items/2/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([iceCream], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(3.5);
  });

  it('parses "2 for $5" style sale_story when current_price is null', () => {
    const twoForFive: FlippItem = {
      ...base,
      flyer_item_id: 113,
      name: 'Two-for Special',
      sale_story: '2 for $5',
    };
    const [deal] = normalizeFlippItems([twoForFive], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(2.5);
  });

  it('parses a bare "$X" price from sale_story when current_price is null', () => {
    const bareDollar: FlippItem = {
      ...base,
      flyer_item_id: 115,
      name: 'Special Item',
      sale_story: 'Only $4.99 each!',
    };
    const [deal] = normalizeFlippItems([bareDollar], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(4.99);
  });

  it('skips BOGO items with no parseable per-unit price', () => {
    const bogo: FlippItem = {
      ...base,
      flyer_item_id: 1026801702,
      name: 'Sprouts Boneless Skinless Chicken Breasts',
      sale_story: 'BUY ONE. GET ONE 50% OFF regular retail of equal or lesser value',
    };
    const result = normalizeFlippItems([bogo], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(result).toHaveLength(0);
  });

  it('prefers clean_image_url but falls back to clipping_image_url', () => {
    const onlyClipping: FlippItem = {
      ...base,
      flyer_item_id: 116,
      name: 'Clipping Only',
      current_price: 3.99,
      clean_image_url: null,
      clipping_image_url: 'https://f.wishabi.net/page_items/3/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([onlyClipping], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.image_url).toBe('https://f.wishabi.net/page_items/3/extra_large.jpg');
  });

  it('returns current_price unchanged when pre_price_text is "1 FOR" (no vacuous division)', () => {
    const singleFor: FlippItem = {
      ...base,
      flyer_item_id: 117,
      name: 'Single-Unit Special',
      current_price: 2.99,
      pre_price_text: '1 FOR',
    };
    const [deal] = normalizeFlippItems([singleFor], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(2.99);
  });

  it('picks the last "$X" when sale_story contains multiple dollar amounts', () => {
    const saveThen: FlippItem = {
      ...base,
      flyer_item_id: 118,
      name: 'Was $X Now $Y',
      sale_story: 'Save $2, now $1.99',
    };
    const [deal] = normalizeFlippItems([saveThen], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(1.99);
  });
});

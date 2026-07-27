import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
vi.mock('@/lib/ingestion/flipp/client', () => ({
  searchFlippMerchant: (input: any) => mockSearch(input),
}));

import { fetchSproutsDeals } from '@/lib/ingestion/sprouts';

beforeEach(() => {
  mockSearch.mockReset();
});

describe('fetchSproutsDeals', () => {
  it('returns a synthesized store and normalized deals when Sprouts is found', async () => {
    mockSearch.mockResolvedValueOnce({
      merchant: { id: 2419, name: 'Sprouts Farmers Market' },
      items: [
        {
          id: 1026801989,
          flyer_item_id: 1026801989,
          flyer_id: 8032364,
          merchant_id: 2419,
          merchant_name: 'Sprouts Farmers Market',
          name: 'Large Yellow or White Peaches',
          item_type: 'flyer',
          current_price: 1.98,
          original_price: null,
          pre_price_text: null,
          post_price_text: '/LB.',
          sale_story: null,
          valid_from: null,
          valid_to: null,
          clean_image_url: null,
          clipping_image_url: null,
        },
      ],
    });

    const result = await fetchSproutsDeals('21224');
    expect(mockSearch).toHaveBeenCalledWith({
      zip: '21224',
      merchantName: 'Sprouts Farmers Market',
    });
    expect(result.stores).toEqual([
      { store_number: 'flipp-2419', address: null, zip: '21224' },
    ]);
    expect(result.deals).toHaveLength(1);
    expect(result.deals[0]).toMatchObject({
      retailer: 'sprouts',
      store_number: 'flipp-2419',
      sale_price: 1.98,
    });
  });

  it('returns empty result when no Sprouts merchant found for the zip', async () => {
    mockSearch.mockResolvedValueOnce({ merchant: null, items: [] });
    const result = await fetchSproutsDeals('99999');
    expect(result.stores).toEqual([]);
    expect(result.deals).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../setup';
import { searchFlippMerchant } from '@/lib/ingestion/flipp/client';
import searchFixture from './fixtures/search-response.json';

describe('searchFlippMerchant', () => {
  it('sends postal_code and q, and returns the merchant plus its items only', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('locale')).toBe('en-US');
        expect(url.searchParams.get('postal_code')).toBe('21224');
        expect(url.searchParams.get('q')).toBe('Sprouts Farmers Market');
        return HttpResponse.json(searchFixture);
      })
    );

    const result = await searchFlippMerchant({
      zip: '21224',
      merchantName: 'Sprouts Farmers Market',
    });

    expect(result.merchant).toEqual({ id: 2419, name: 'Sprouts Farmers Market' });
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.merchant_id).toBe(2419);
    }
  });

  it('picks the merchant by case-insensitive name match', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({
          merchants: [
            { id: 1, name: 'Other Store' },
            { id: 2419, name: 'Sprouts Farmers Market' },
          ],
          items: [],
        })
      )
    );

    const result = await searchFlippMerchant({
      zip: '21224',
      merchantName: 'sprouts farmers market',
    });
    expect(result.merchant?.id).toBe(2419);
  });

  it('returns { merchant: null, items: [] } when no merchant matches', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({ merchants: [], items: [] })
      )
    );

    const result = await searchFlippMerchant({
      zip: '99999',
      merchantName: 'Sprouts Farmers Market',
    });
    expect(result).toEqual({ merchant: null, items: [] });
  });

  it('throws on non-2xx responses', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );

    await expect(
      searchFlippMerchant({ zip: '21224', merchantName: 'Sprouts Farmers Market' })
    ).rejects.toThrow(/Flipp search failed: 500/);
  });
});

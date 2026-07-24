import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/products-response.json';
import { searchKrogerProducts } from '@/lib/ingestion/harris-teeter/products';

describe('searchKrogerProducts', () => {
  it('returns raw Kroger products for a store', async () => {
    let capturedUrl: URL | null = null;

    server.use(
      http.get('https://api.kroger.com/v1/products', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(fixture);
      })
    );

    const products = await searchKrogerProducts({
      storeId: '09700123',
      term: 'chicken',
      accessToken: 'fake-token',
    });

    expect(products).toHaveLength(2);
    expect(products[0].productId).toBe('0001111041700');
    expect(products[0].items[0].price.regular).toBe(4.99);
    expect(products[0].items[0].price.promo).toBe(3.49);

    expect(capturedUrl?.searchParams.get('filter.locationId')).toBe('09700123');
    expect(capturedUrl?.searchParams.get('filter.term')).toBe('chicken');
    expect(capturedUrl?.searchParams.get('filter.limit')).toBe('50');
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.get('https://api.kroger.com/v1/products', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );
    await expect(
      searchKrogerProducts({ storeId: 'x', term: 'y', accessToken: 't' })
    ).rejects.toThrow(/500/);
  });
});

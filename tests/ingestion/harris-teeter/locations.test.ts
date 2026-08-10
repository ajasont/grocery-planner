import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/setup';
import fixture from './fixtures/locations-response.json';
import { findHarrisTeeterStores } from '@/lib/ingestion/harris-teeter/locations';

describe('findHarrisTeeterStores', () => {
  it('returns HT stores near the given zip', async () => {
    let capturedUrl: URL | null = null;
    let capturedAuth: string | null = null;

    server.use(
      http.get('https://api.kroger.com/v1/locations', ({ request }) => {
        capturedUrl = new URL(request.url);
        capturedAuth = request.headers.get('authorization');
        return HttpResponse.json(fixture);
      })
    );

    const stores = await findHarrisTeeterStores('21224', 'fake-token');
    expect(stores).toHaveLength(2);
    expect(stores[0]).toEqual({
      store_number: '09700123',
      name: 'Harris Teeter Locust Point',
      address: '1801 Whetstone Way, Baltimore, MD 21230',
      zip: '21230',
    });

    // Verify the query params and bearer token
    expect(capturedUrl!.searchParams.get('filter.zipCode.near')).toBe('21224');
    expect(capturedUrl!.searchParams.get('filter.chain')).toBe('HART');
    expect(capturedAuth).toBe('Bearer fake-token');
  });

  it('throws on non-2xx response', async () => {
    server.use(
      http.get('https://api.kroger.com/v1/locations', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );
    await expect(findHarrisTeeterStores('21224', 'fake-token')).rejects.toThrow(/500/);
  });
});

import { getKrogerAccessToken } from './auth';
import { findHarrisTeeterStores } from './locations';
import { searchKrogerProducts } from './products';
import { normalizeKrogerProducts } from './normalize';
import type { NormalizedDeal, IngestionStore } from '@/lib/ingestion/types';

// Broad category search terms — covers most weekly deals in a few calls.
// We accept some duplicate SKUs across terms; the caller de-dupes by (sku).
const SEARCH_TERMS = [
  'chicken', 'beef', 'pork', 'seafood', 'produce', 'dairy',
  'bread', 'pasta', 'rice', 'cheese', 'yogurt', 'cereal',
  'snack', 'frozen', 'canned', 'oil',
];

export async function fetchHarrisTeeterDeals(zip: string): Promise<{
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}> {
  const token = await getKrogerAccessToken();
  const stores = await findHarrisTeeterStores(zip, token);
  if (stores.length === 0) return { stores: [], deals: [] };

  // MVP: pull deals from the closest store only.
  const store = stores[0];
  const seenSkus = new Set<string>();
  const allDeals: NormalizedDeal[] = [];

  for (const term of SEARCH_TERMS) {
    try {
      const products = await searchKrogerProducts({
        storeId: store.store_number,
        term,
        accessToken: token,
      });
      const normalized = normalizeKrogerProducts(products, store.store_number);
      for (const d of normalized) {
        if (seenSkus.has(d.sku)) continue;
        seenSkus.add(d.sku);
        allDeals.push(d);
      }
    } catch (err) {
      console.warn(`Kroger search failed for term "${term}":`, err);
    }
  }

  return {
    stores: stores.map((s) => ({
      store_number: s.store_number,
      address: s.address,
      zip: s.zip,
    })),
    deals: allDeals,
  };
}

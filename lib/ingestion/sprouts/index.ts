import { searchFlippMerchant } from '@/lib/ingestion/flipp/client';
import { normalizeFlippItems } from '@/lib/ingestion/flipp/normalize';
import type { NormalizedDeal, IngestionStore } from '@/lib/ingestion/types';

export async function fetchSproutsDeals(zip: string): Promise<{
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}> {
  const { merchant, items } = await searchFlippMerchant({
    zip,
    merchantName: 'Sprouts Farmers Market',
  });
  if (!merchant) return { stores: [], deals: [] };

  const storeNumber = `flipp-${merchant.id}`;
  const deals = normalizeFlippItems(items, { retailer: 'sprouts', storeNumber });

  return {
    stores: [{ store_number: storeNumber, address: null, zip }],
    deals,
  };
}

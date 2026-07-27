import { searchFlippMerchant } from '@/lib/ingestion/flipp/client';
import { normalizeFlippItems } from '@/lib/ingestion/flipp/normalize';
import type { NormalizedDeal, IngestionStore } from '@/lib/ingestion/types';

const SPROUTS_MERCHANT_NAME = 'Sprouts Farmers Market';
const FLIPP_STORE_PREFIX = 'flipp-';

export async function fetchSproutsDeals(zip: string): Promise<{
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}> {
  const { merchant, items } = await searchFlippMerchant({
    zip,
    merchantName: SPROUTS_MERCHANT_NAME,
  });
  if (!merchant) {
    console.warn(
      `fetchSproutsDeals: no Sprouts Farmers Market merchant found for zip ${zip}`
    );
    return { stores: [], deals: [] };
  }

  const storeNumber = `${FLIPP_STORE_PREFIX}${merchant.id}`;
  const deals = normalizeFlippItems(items, { retailer: 'sprouts', storeNumber });

  return {
    stores: [{ store_number: storeNumber, address: null, zip }],
    deals,
  };
}

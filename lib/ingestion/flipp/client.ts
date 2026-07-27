import type { FlippMerchant, FlippItem, FlippSearchResponse } from './types';

const BASE = 'https://backflipp.wishabi.com/flipp';

export async function searchFlippMerchant(input: {
  zip: string;
  merchantName: string;
}): Promise<{ merchant: FlippMerchant | null; items: FlippItem[] }> {
  const url = new URL(`${BASE}/items/search`);
  url.searchParams.set('locale', 'en-US');
  url.searchParams.set('postal_code', input.zip);
  url.searchParams.set('q', input.merchantName);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Flipp search failed: ${res.status}`);
  const body = (await res.json()) as Partial<FlippSearchResponse>;

  const merchants = body.merchants ?? [];
  const wanted = input.merchantName.toLowerCase();
  const merchant = merchants.find((m) => m.name.toLowerCase() === wanted) ?? null;

  if (!merchant) return { merchant: null, items: [] };

  const allItems = body.items ?? [];
  const items = allItems.filter((it) => it.merchant_id === merchant.id);
  return { merchant, items };
}

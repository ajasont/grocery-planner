const PRODUCTS_URL = 'https://api.kroger.com/v1/products';

export type KrogerProduct = {
  productId: string;
  description: string;
  brand?: string;
  categories?: string[];
  images?: Array<{ sizes: Array<{ size: string; url: string }> }>;
  items: Array<{
    itemId: string;
    size?: string;
    price?: { regular: number; promo: number };
    fulfillment?: { instore: boolean };
  }>;
};

export async function searchKrogerProducts(args: {
  storeId: string;
  term: string;
  accessToken: string;
  limit?: number;
}): Promise<KrogerProduct[]> {
  const url = new URL(PRODUCTS_URL);
  url.searchParams.set('filter.locationId', args.storeId);
  url.searchParams.set('filter.term', args.term);
  url.searchParams.set('filter.limit', String(args.limit ?? 50));

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kroger products failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: KrogerProduct[] };
  return data.data;
}

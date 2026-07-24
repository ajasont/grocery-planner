import type { NormalizedDeal } from '@/lib/ingestion/types';
import type { KrogerProduct } from './products';

const SIZE_RE = /^\s*([\d.]+)\s*(\w+)\s*$/;

function parseSize(size?: string): { value: number | null; unit: string | null } {
  if (!size) return { value: null, unit: null };
  const m = size.match(SIZE_RE);
  if (!m) return { value: null, unit: null };
  return { value: parseFloat(m[1]), unit: m[2].toLowerCase() };
}

function firstImage(p: KrogerProduct): string | null {
  const url = p.images?.[0]?.sizes?.[0]?.url;
  return url ?? null;
}

export function normalizeKrogerProducts(
  products: KrogerProduct[],
  storeNumber: string
): NormalizedDeal[] {
  const deals: NormalizedDeal[] = [];
  for (const p of products) {
    const item = p.items?.[0];
    if (!item) continue;
    const { value: package_size, unit: package_unit } = parseSize(item.size);
    const regular = item.price?.regular ?? null;
    const promo = item.price?.promo && item.price.promo > 0 ? item.price.promo : null;
    deals.push({
      retailer: 'harris-teeter',
      store_number: storeNumber,
      sku: item.itemId,
      product_name: p.description,
      package_size,
      package_unit,
      image_url: firstImage(p),
      regular_price: regular,
      sale_price: promo,
      on_sale: promo !== null && regular !== null && promo < regular,
      source: 'api',
    });
  }
  return deals;
}

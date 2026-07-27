import type { NormalizedDeal, RetailerName } from '@/lib/ingestion/types';
import type { FlippItem } from './types';

const SINGLE_PRICE_RE_G = /\$([\d]+(?:\.[\d]+)?)/g;
const N_FOR_PRICE_RE = /(\d+)\s*for\s*\$([\d]+(?:\.[\d]+)?)/i;
const LEADING_QTY_RE = /^\s*(\d+)\s+for\b/i;

function parsePrice(item: FlippItem): number | null {
  // current_price of 0 (or null) is treated as "no price" — free promotional items fall through to sale_story parsing and are skipped if that yields nothing.
  // "N FOR" bundle price: current_price is the total for N units.
  if (item.current_price != null && item.current_price > 0 && item.pre_price_text) {
    const qtyMatch = item.pre_price_text.match(LEADING_QTY_RE);
    if (qtyMatch) {
      const qty = parseInt(qtyMatch[1], 10);
      if (qty > 1) return Math.round((item.current_price / qty) * 100) / 100;
    }
  }
  if (item.current_price != null && item.current_price > 0) return item.current_price;

  // Fall back to parsing sale_story for "N for $X" or bare "$X".
  const text = item.sale_story;
  if (!text) return null;
  const nFor = text.match(N_FOR_PRICE_RE);
  if (nFor) {
    const qty = parseInt(nFor[1], 10);
    const total = parseFloat(nFor[2]);
    if (qty > 0 && total > 0) return Math.round((total / qty) * 100) / 100;
  }
  const singleMatches = [...text.matchAll(SINGLE_PRICE_RE_G)];
  if (singleMatches.length > 0) {
    return parseFloat(singleMatches[singleMatches.length - 1][1]);
  }
  return null;
}

export function normalizeFlippItems(
  items: FlippItem[],
  ctx: { retailer: RetailerName; storeNumber: string }
): NormalizedDeal[] {
  const deals: NormalizedDeal[] = [];
  for (const it of items) {
    const price = parsePrice(it);
    if (price === null) continue;
    deals.push({
      retailer: ctx.retailer,
      store_number: ctx.storeNumber,
      sku: `flipp-${it.flyer_item_id}`,
      product_name: it.name,
      package_size: null,
      package_unit: null,
      image_url: it.clean_image_url ?? it.clipping_image_url ?? null,
      regular_price: null,
      sale_price: price,
      on_sale: true,
      source: 'flipp',
    });
  }
  return deals;
}

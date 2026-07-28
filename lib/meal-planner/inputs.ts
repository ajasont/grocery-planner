import type { PlannerDeal } from './types';

export type DealRow = {
  canonical_id: string | null;
  canonical_name: string | null;
  category: string | null;
  retailer_name: string;
  sale_price: number | null;
};

export function cheapestByCanonical(rows: DealRow[]): PlannerDeal[] {
  const best = new Map<string, PlannerDeal>();
  for (const r of rows) {
    if (!r.canonical_id || !r.canonical_name || r.sale_price === null) continue;
    const existing = best.get(r.canonical_id);
    if (!existing || r.sale_price < existing.sale_price) {
      best.set(r.canonical_id, {
        canonical_id: r.canonical_id,
        canonical_name: r.canonical_name,
        category: r.category,
        cheapest_retailer: r.retailer_name,
        sale_price: r.sale_price,
      });
    }
  }
  const out: PlannerDeal[] = [];
  best.forEach((v) => out.push(v));
  out.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
  return out;
}

export type GroupInput = {
  sku_id: number;
  retailer_name: string;
  canonical_ingredient_id: string | null;
  canonical_name: string | null;
  product_name: string;
  sale_price: number | null;
  regular_price: number | null;
  image_url: string | null;
};

export type DealGroup = {
  key: string;
  retailer_name: string;
  canonical_name: string | null;
  sample_product_name: string;
  sample_image_url: string | null;
  sale_price: number | null;
  regular_price: number | null;
  variant_count: number;
};

function groupKey(row: GroupInput): string {
  return row.canonical_ingredient_id
    ? `${row.retailer_name}:c:${row.canonical_ingredient_id}`
    : `${row.retailer_name}:s:${row.sku_id}`;
}

function cheaper(a: GroupInput, b: GroupInput): GroupInput {
  const ap = a.sale_price ?? Number.POSITIVE_INFINITY;
  const bp = b.sale_price ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap < bp ? a : b;
  return a.product_name <= b.product_name ? a : b;
}

export function groupDeals(
  rows: GroupInput[],
  opts: { perRetailer?: number } = {}
): DealGroup[] {
  const byKey = new Map<string, { sample: GroupInput; count: number }>();

  for (const row of rows) {
    const key = groupKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { sample: row, count: 1 });
    } else {
      existing.sample = cheaper(existing.sample, row);
      existing.count += 1;
    }
  }

  const groups: DealGroup[] = [];
  byKey.forEach(({ sample, count }, key) => {
    groups.push({
      key,
      retailer_name: sample.retailer_name,
      canonical_name: sample.canonical_name,
      sample_product_name: sample.product_name,
      sample_image_url: sample.image_url,
      sale_price: sample.sale_price,
      regular_price: sample.regular_price,
      variant_count: count,
    });
  });

  groups.sort((a, b) => {
    const ap = a.sale_price ?? Number.POSITIVE_INFINITY;
    const bp = b.sale_price ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.sample_product_name.localeCompare(b.sample_product_name);
  });

  if (opts.perRetailer !== undefined) {
    const cap = opts.perRetailer;
    const perRetailerCount = new Map<string, number>();
    const capped: DealGroup[] = [];
    for (const g of groups) {
      const seen = perRetailerCount.get(g.retailer_name) ?? 0;
      if (seen >= cap) continue;
      perRetailerCount.set(g.retailer_name, seen + 1);
      capped.push(g);
    }
    return capped;
  }

  return groups;
}

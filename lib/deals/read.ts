import { getServerClient } from '@/lib/db/client';

export type DealForDisplay = {
  product_name: string;
  regular_price: number | null;
  sale_price: number | null;
  image_url: string | null;
  retailer_name: string;
};

function currentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

export async function getCurrentWeekOnSaleDeals(
  perRetailer = 30
): Promise<DealForDisplay[]> {
  const supabase = getServerClient();
  const weekOf = currentWeekOfISO();

  // Fetch all this-week on-sale deals; we top-N per retailer in memory so a
  // single dense retailer (e.g. HT with 300+ items) can't crowd everyone out.
  const { data, error } = await supabase
    .from('deals')
    .select(
      `regular_price, sale_price,
       retailer_skus!inner (product_name, image_url,
         retailers!inner (name))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null)
    .order('sale_price', { ascending: true });

  if (error) throw error;
  if (!data) return [];

  type Row = {
    regular_price: number | null;
    sale_price: number | null;
    retailer_skus: {
      product_name: string;
      image_url: string | null;
      retailers: { name: string };
    };
  };

  const perRetailerCount = new Map<string, number>();
  const results: DealForDisplay[] = [];
  for (const row of data as unknown as Row[]) {
    const name = row.retailer_skus.retailers.name;
    const seen = perRetailerCount.get(name) ?? 0;
    if (seen >= perRetailer) continue;
    perRetailerCount.set(name, seen + 1);
    results.push({
      product_name: row.retailer_skus.product_name,
      regular_price: row.regular_price,
      sale_price: row.sale_price,
      image_url: row.retailer_skus.image_url,
      retailer_name: name,
    });
  }
  return results;
}

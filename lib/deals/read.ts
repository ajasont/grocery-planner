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

export async function getCurrentWeekOnSaleDeals(limit = 60): Promise<DealForDisplay[]> {
  const supabase = getServerClient();
  const weekOf = currentWeekOfISO();

  const { data, error } = await supabase
    .from('deals')
    .select(
      `regular_price, sale_price,
       retailer_skus!inner (product_name, image_url,
         retailers!inner (name))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null)
    .order('sale_price', { ascending: true })
    .limit(limit);

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
  return (data as unknown as Row[]).map((row) => ({
    product_name: row.retailer_skus.product_name,
    regular_price: row.regular_price,
    sale_price: row.sale_price,
    image_url: row.retailer_skus.image_url,
    retailer_name: row.retailer_skus.retailers.name,
  }));
}

import { getServerClient } from '@/lib/db/client';
import { groupDeals, type DealGroup, type GroupInput } from '@/lib/deals/group';
import { getCurrentWeekOfISO } from '@/lib/dates';

export async function getCurrentWeekOnSaleDeals(
  perRetailer = 30
): Promise<DealGroup[]> {
  const supabase = getServerClient();
  const weekOf = getCurrentWeekOfISO();

  const { data, error } = await supabase
    .from('deals')
    .select(
      `regular_price, sale_price,
       retailer_skus!inner (id, product_name, image_url, canonical_ingredient_id,
         retailers!inner (name),
         canonical_ingredients (name))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null)
    .not('retailer_skus.is_ingredient', 'is', false)
    .order('sale_price', { ascending: true });

  if (error) throw error;
  if (!data) return [];

  type Row = {
    regular_price: number | null;
    sale_price: number | null;
    retailer_skus: {
      id: number;
      product_name: string;
      image_url: string | null;
      canonical_ingredient_id: string | null;
      retailers: { name: string };
      canonical_ingredients: { name: string } | null;
    };
  };

  const inputs: GroupInput[] = (data as unknown as Row[]).map((row) => ({
    sku_id: row.retailer_skus.id,
    retailer_name: row.retailer_skus.retailers.name,
    canonical_ingredient_id: row.retailer_skus.canonical_ingredient_id,
    canonical_name: row.retailer_skus.canonical_ingredients?.name ?? null,
    product_name: row.retailer_skus.product_name,
    sale_price: row.sale_price,
    regular_price: row.regular_price,
    image_url: row.retailer_skus.image_url,
  }));

  return groupDeals(inputs, { perRetailer });
}

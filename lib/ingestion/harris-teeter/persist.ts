import { getServerClient } from '@/lib/db/client';
import type { NormalizedDeal } from '@/lib/ingestion/types';
import type { HTStore } from './locations';

function currentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

export async function persistHarrisTeeterDeals(input: {
  stores: HTStore[];
  deals: NormalizedDeal[];
}) {
  const supabase = getServerClient();

  const { data: retailerRow, error: rErr } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', 'harris-teeter')
    .single();
  if (rErr || !retailerRow) throw new Error('harris-teeter retailer row missing');
  const retailerId = retailerRow.id;

  // Upsert stores
  const storeRows = input.stores.map((s) => ({
    retailer_id: retailerId,
    store_number: s.store_number,
    address: s.address,
    zip: s.zip,
    is_active: true,
  }));
  const { error: sErr } = await supabase
    .from('stores')
    .upsert(storeRows, { onConflict: 'retailer_id,store_number' });
  if (sErr) throw sErr;

  // Reload store IDs
  const { data: storeIdRows, error: sIdErr } = await supabase
    .from('stores')
    .select('id, store_number')
    .eq('retailer_id', retailerId);
  if (sIdErr || !storeIdRows) throw sIdErr ?? new Error('no stores');
  const storeIdByNumber = new Map(storeIdRows.map((r) => [r.store_number, r.id]));

  // Upsert retailer_skus
  const skuRows = input.deals.map((d) => ({
    retailer_id: retailerId,
    sku: d.sku,
    product_name: d.product_name,
    package_size: d.package_size,
    package_unit: d.package_unit,
    image_url: d.image_url,
  }));
  const { error: skuErr } = await supabase
    .from('retailer_skus')
    .upsert(skuRows, { onConflict: 'retailer_id,sku', ignoreDuplicates: false });
  if (skuErr) throw skuErr;

  // Reload SKU IDs
  const skus = input.deals.map((d) => d.sku);
  const { data: skuIdRows, error: skuIdErr } = await supabase
    .from('retailer_skus')
    .select('id, sku')
    .eq('retailer_id', retailerId)
    .in('sku', skus);
  if (skuIdErr || !skuIdRows) throw skuIdErr ?? new Error('no skus');
  const skuIdByCode = new Map(skuIdRows.map((r) => [r.sku, r.id]));

  // Upsert deals
  const weekOf = currentWeekOfISO();
  const dealRows = input.deals
    .map((d) => {
      const storeId = storeIdByNumber.get(d.store_number);
      const skuId = skuIdByCode.get(d.sku);
      if (!storeId || !skuId) return null;
      return {
        retailer_sku_id: skuId,
        store_id: storeId,
        week_of: weekOf,
        regular_price: d.regular_price,
        sale_price: d.sale_price,
        unit_price: null,
        valid_from: null,
        valid_until: null,
        source: d.source,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const { error: dErr } = await supabase
    .from('deals')
    .upsert(dealRows, { onConflict: 'retailer_sku_id,store_id,week_of' });
  if (dErr) throw dErr;

  // Update health
  await supabase
    .from('retailer_health')
    .upsert(
      { retailer_id: retailerId, last_success_at: new Date().toISOString(), last_status: 'OK', last_error: null },
      { onConflict: 'retailer_id' }
    );

  return { dealsUpserted: dealRows.length };
}

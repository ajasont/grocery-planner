import { getServerClient } from '@/lib/db/client';
import { mapProductNames } from './mapper';

export async function runMappingForUnmappedSkus(): Promise<{
  mapped: number;
  skipped: number;
}> {
  const supabase = getServerClient();

  // Fetch SKUs that have no mapping and haven't been manually verified.
  const { data, error } = await supabase
    .from('retailer_skus')
    .select('id, product_name')
    .is('canonical_ingredient_id', null)
    .eq('mapping_verified', false);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: number; product_name: string }>;
  if (rows.length === 0) return { mapped: 0, skipped: 0 };

  const mappings = await mapProductNames(rows.map((r) => r.product_name));

  const updates: Array<{
    id: number;
    canonical_ingredient_id: string;
    mapping_confidence: number;
  }> = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const m = mappings[i];
    if (!m || m.canonical_id === null) {
      skipped++;
      continue;
    }
    updates.push({
      id: rows[i].id,
      canonical_ingredient_id: m.canonical_id,
      mapping_confidence: m.confidence,
    });
  }

  if (updates.length > 0) {
    const { error: upErr } = await supabase
      .from('retailer_skus')
      .upsert(updates, { onConflict: 'id' });
    if (upErr) throw upErr;
  }

  return { mapped: updates.length, skipped };
}

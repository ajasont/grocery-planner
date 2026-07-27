import { getServerClient } from '@/lib/db/client';
import { mapProductNames } from './mapper';

export async function runMappingForUnmappedSkus(): Promise<{
  mapped: number;
  skipped: number;
  failed: number;
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
  if (rows.length === 0) return { mapped: 0, skipped: 0, failed: 0 };

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

  let mapped = 0;
  let failed = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('retailer_skus')
      .update({
        canonical_ingredient_id: u.canonical_ingredient_id,
        mapping_confidence: u.mapping_confidence,
      })
      .eq('id', u.id);
    if (upErr) {
      failed++;
      console.warn(
        `retailer_skus update failed for id=${u.id} canonical_id=${u.canonical_ingredient_id}:`,
        upErr
      );
      continue;
    }
    mapped++;
  }

  return { mapped, skipped, failed };
}

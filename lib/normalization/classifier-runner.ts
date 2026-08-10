import { getServerClient } from '@/lib/db/client';
import { classifyProductNames } from './classifier';

export type ClassifierRunResult = {
  classified: number;
  flagged: number;
  failed: number;
};

export async function runClassificationForUnclassifiedFlippSkus(): Promise<ClassifierRunResult> {
  const supabase = getServerClient();

  // Uses the partial index idx_retailer_skus_unclassified_flipp.
  const { data, error } = await supabase
    .from('retailer_skus')
    .select('id, product_name, canonical_ingredient_id')
    .is('is_ingredient', null)
    .like('sku', 'flipp-%');
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: number;
    product_name: string;
    canonical_ingredient_id: string | null;
  }>;
  if (rows.length === 0) return { classified: 0, flagged: 0, failed: 0 };

  const classifications = await classifyProductNames(rows.map((r) => r.product_name));

  let classified = 0;
  let flagged = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const c = classifications[i];
    if (!c) {
      failed++;
      continue;
    }
    const payload: {
      is_ingredient: boolean;
      classification_confidence: number;
      classification_reason: string;
      canonical_ingredient_id?: null;
      mapping_confidence?: null;
    } = {
      is_ingredient: c.is_ingredient,
      classification_confidence: c.confidence,
      classification_reason: c.reason,
    };
    // Cascade-clear a bad mapping when we're now flagging as non-ingredient.
    if (c.is_ingredient === false && row.canonical_ingredient_id !== null) {
      payload.canonical_ingredient_id = null;
      payload.mapping_confidence = null;
    }
    const { error: upErr } = await supabase
      .from('retailer_skus')
      .update(payload)
      .eq('id', row.id);
    if (upErr) {
      failed++;
      console.warn(
        `classifier update failed for id=${row.id}:`,
        upErr
      );
      continue;
    }
    classified++;
    if (c.is_ingredient === false) flagged++;
  }

  return { classified, flagged, failed };
}

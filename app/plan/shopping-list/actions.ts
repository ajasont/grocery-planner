'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function toggleShoppingItem(
  planId: number,
  memberCanonicalIds: readonly string[],
  nextChecked: boolean
): Promise<void> {
  if (memberCanonicalIds.length === 0) return;
  const supabase = getServerClient();

  if (nextChecked) {
    // 1. Persist one check row per member canonical.
    const checkRows = memberCanonicalIds.map((canonicalId) => ({
      meal_plan_id: planId,
      canonical_ingredient_id: canonicalId,
    }));
    const { error: checkErr } = await supabase
      .from('shopping_list_checks')
      .upsert(checkRows);
    if (checkErr) throw checkErr;

    // 2. Auto-add every member to pantry. Idempotent via UNIQUE(canonical_ingredient_id).
    for (const canonicalId of memberCanonicalIds) {
      const { error: pantryErr } = await supabase
        .from('pantry')
        .upsert(
          { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
          { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
        );
      if (pantryErr) throw pantryErr;
    }
  } else {
    // Uncheck: remove the N check rows in one query. Do NOT touch pantry
    // (matches prior behavior — unchecks are usually corrections).
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .in('canonical_ingredient_id', memberCanonicalIds as string[]);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
  revalidatePath('/pantry');
}

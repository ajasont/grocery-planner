'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function toggleShoppingItem(
  planId: number,
  canonicalId: string,
  nextChecked: boolean
): Promise<void> {
  const supabase = getServerClient();
  if (nextChecked) {
    // 1. Persist the check.
    const { error: checkErr } = await supabase
      .from('shopping_list_checks')
      .upsert({ meal_plan_id: planId, canonical_ingredient_id: canonicalId });
    if (checkErr) throw checkErr;

    // 2. Auto-add to pantry. Idempotent thanks to UNIQUE(canonical_ingredient_id).
    //    From here on, the live-pantry filter in buildShoppingList drops the row
    //    from the visible list — the check state on this row becomes moot.
    const { error: pantryErr } = await supabase
      .from('pantry')
      .upsert(
        { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
        { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
      );
    if (pantryErr) throw pantryErr;
  } else {
    // Uncheck: remove the check row only. Do NOT auto-remove from pantry
    // (unchecks are usually corrections, not "I ate it already").
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .eq('canonical_ingredient_id', canonicalId);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
  revalidatePath('/pantry');
}

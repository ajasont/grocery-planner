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
    const { error } = await supabase
      .from('shopping_list_checks')
      .upsert({ meal_plan_id: planId, canonical_ingredient_id: canonicalId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .eq('canonical_ingredient_id', canonicalId);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
}

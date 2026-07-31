'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function addToPantry(canonicalId: string): Promise<void> {
  const supabase = getServerClient();
  // Insert is idempotent thanks to the UNIQUE constraint on canonical_ingredient_id.
  const { error } = await supabase
    .from('pantry')
    .upsert(
      { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
      { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
    );
  if (error) throw error;
  revalidatePath('/pantry');
  revalidatePath('/plan/shopping-list');
}

export async function removeFromPantry(canonicalId: string): Promise<void> {
  const supabase = getServerClient();
  const { error } = await supabase
    .from('pantry')
    .delete()
    .eq('canonical_ingredient_id', canonicalId);
  if (error) throw error;
  revalidatePath('/pantry');
  revalidatePath('/plan/shopping-list');
}

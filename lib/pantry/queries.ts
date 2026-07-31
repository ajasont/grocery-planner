import { getServerClient } from '@/lib/db/client';

export type PantryItem = {
  canonicalId: string;
  name: string;
};

export async function listPantry(): Promise<PantryItem[]> {
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('pantry')
    .select('canonical_ingredient_id, canonical_ingredients (name)');
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    canonical_ingredient_id: string;
    canonical_ingredients: { name: string } | null;
  }>;

  return rows
    .filter((r) => r.canonical_ingredients !== null)
    .map((r) => ({
      canonicalId: r.canonical_ingredient_id,
      name: (r.canonical_ingredients as { name: string }).name,
    }));
}

export async function listPantryIds(): Promise<string[]> {
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('pantry')
    .select('canonical_ingredient_id');
  if (error) throw error;
  return ((data ?? []) as Array<{ canonical_ingredient_id: string }>).map(
    (r) => r.canonical_ingredient_id
  );
}

import { getServerClient } from '@/lib/db/client';

export type CanonicalMini = {
  id: string;
  name: string;
  category: string | null;
};

let cache: CanonicalMini[] | null = null;

export async function getCanonicalIngredients(): Promise<CanonicalMini[]> {
  if (cache) return cache;
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('canonical_ingredients')
    .select('id, name, category');
  if (error) throw error;
  cache = (data ?? []) as CanonicalMini[];
  return cache;
}

// For tests
export function _resetCanonicalCache() {
  cache = null;
}

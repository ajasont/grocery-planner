import type { PlannerDeal } from './types';
import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';
import type {
  PlannerInput,
  PlannerPantryItem,
  PlannerPreferences,
} from './types';

export type DealRow = {
  canonical_id: string | null;
  canonical_name: string | null;
  category: string | null;
  retailer_name: string;
  sale_price: number | null;
};

export function cheapestByCanonical(rows: DealRow[]): PlannerDeal[] {
  const best = new Map<string, PlannerDeal>();
  for (const r of rows) {
    if (!r.canonical_id || !r.canonical_name || r.sale_price === null) continue;
    const existing = best.get(r.canonical_id);
    if (!existing || r.sale_price < existing.sale_price) {
      best.set(r.canonical_id, {
        canonical_id: r.canonical_id,
        canonical_name: r.canonical_name,
        category: r.category,
        cheapest_retailer: r.retailer_name,
        sale_price: r.sale_price,
      });
    }
  }
  const out: PlannerDeal[] = [];
  best.forEach((v) => out.push(v));
  out.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
  return out;
}

const EMPTY_PREFERENCES: PlannerPreferences = {
  dietary_flags: [],
  disliked_ingredients: [],
  liked_ingredients: [],
  disliked_cuisines: [],
  liked_cuisines: [],
};

export async function getPlannerInput(): Promise<PlannerInput> {
  const supabase = getServerClient();
  const weekOf = getCurrentWeekOfISO();

  // Deals for this week, joined to canonical + retailer info.
  const { data: dealRows, error: dealErr } = await supabase
    .from('deals')
    .select(
      `sale_price,
       retailer_skus!inner (canonical_ingredient_id,
         retailers!inner (name),
         canonical_ingredients (id, name, category))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null);
  if (dealErr) throw dealErr;

  type Row = {
    sale_price: number | null;
    retailer_skus: {
      canonical_ingredient_id: string | null;
      retailers: { name: string };
      canonical_ingredients: { id: string; name: string; category: string | null } | null;
    };
  };

  const dealInputs: DealRow[] = ((dealRows ?? []) as unknown as Row[]).map((r) => ({
    canonical_id: r.retailer_skus.canonical_ingredients?.id ?? null,
    canonical_name: r.retailer_skus.canonical_ingredients?.name ?? null,
    category: r.retailer_skus.canonical_ingredients?.category ?? null,
    retailer_name: r.retailer_skus.retailers.name,
    sale_price: r.sale_price,
  }));
  const deals = cheapestByCanonical(dealInputs);

  // Pantry (empty for MVP but the query is real).
  const { data: pantryRows, error: pantryErr } = await supabase
    .from('pantry')
    .select('canonical_ingredient_id, canonical_ingredients (name)');
  if (pantryErr) throw pantryErr;
  const pantry: PlannerPantryItem[] = (
    (pantryRows ?? []) as unknown as Array<{
      canonical_ingredient_id: string;
      canonical_ingredients: { name: string } | null;
    }>
  )
    .filter((r) => r.canonical_ingredients !== null)
    .map((r) => ({
      canonical_id: r.canonical_ingredient_id,
      canonical_name: r.canonical_ingredients!.name,
    }));

  // Household preferences (single row, seeded in the initial migration).
  const { data: prefsRow, error: prefsErr } = await supabase
    .from('household_preferences')
    .select(
      'dietary_flags, disliked_ingredients, liked_ingredients, disliked_cuisines, liked_cuisines'
    )
    .eq('id', 1)
    .maybeSingle();
  if (prefsErr) throw prefsErr;
  const preferences: PlannerPreferences = prefsRow
    ? {
        dietary_flags: (prefsRow.dietary_flags as string[]) ?? [],
        disliked_ingredients: (prefsRow.disliked_ingredients as string[]) ?? [],
        liked_ingredients: (prefsRow.liked_ingredients as string[]) ?? [],
        disliked_cuisines: (prefsRow.disliked_cuisines as string[]) ?? [],
        liked_cuisines: (prefsRow.liked_cuisines as string[]) ?? [],
      }
    : EMPTY_PREFERENCES;

  // Prior 3 weeks of meal names, most-recent-first.
  const { data: priorRows, error: priorErr } = await supabase
    .from('meal_plans')
    .select('id, meals (name)')
    .neq('week_of', weekOf)
    .order('week_of', { ascending: false })
    .limit(3);
  if (priorErr) throw priorErr;
  const prior_meal_names: string[] = [];
  for (const p of (priorRows ?? []) as Array<{ meals: Array<{ name: string }> }>) {
    for (const m of p.meals ?? []) prior_meal_names.push(m.name);
  }

  return { deals, pantry, preferences, prior_meal_names };
}

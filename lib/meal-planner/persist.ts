import { getServerClient } from '@/lib/db/client';
import type { GeneratedPlan } from './types';

export async function savePlan(
  plan: GeneratedPlan,
  weekOf: string,
  pantryCanonicalIds: string[]
): Promise<{ mealPlanId: number }> {
  const supabase = getServerClient();

  // 1. Delete any existing plan for the same week (cascades to meals + meal_ingredients + shopping_list_checks).
  const { error: delErr } = await supabase
    .from('meal_plans')
    .delete()
    .eq('week_of', weekOf);
  if (delErr) throw delErr;

  // 2. Insert the new meal_plans row with the pantry snapshot.
  const { data: mpRow, error: mpErr } = await supabase
    .from('meal_plans')
    .insert({
      week_of: weekOf,
      status: 'draft',
      pantry_canonical_ingredient_ids: pantryCanonicalIds,
    })
    .select('id')
    .single();
  if (mpErr || !mpRow) throw mpErr ?? new Error('meal_plans insert returned no row');
  const mealPlanId = mpRow.id as number;

  // 3. Insert meals in a single batch, then re-read with IDs.
  const mealRows = plan.meals.map((m) => ({
    meal_plan_id: mealPlanId,
    day: m.day,
    meal_type: m.meal_type,
    name: m.name,
    cuisine: m.cuisine,
    cook_time_minutes: m.cook_time_minutes,
    servings: m.servings,
    notes: m.notes,
  }));
  const { data: insertedMeals, error: mealErr } = await supabase
    .from('meals')
    .insert(mealRows)
    .select('id, day, meal_type, name');
  if (mealErr || !insertedMeals) {
    throw mealErr ?? new Error('meals insert returned no rows');
  }

  // 4. Pair each inserted meal back to its ingredient list.
  // Key by day+meal_type+name (unique within a plan).
  const idByKey = new Map<string, number>();
  for (const im of insertedMeals as Array<{
    id: number;
    day: string;
    meal_type: string;
    name: string;
  }>) {
    idByKey.set(`${im.day}|${im.meal_type}|${im.name}`, im.id);
  }

  const ingredientRows: Array<{
    meal_id: number;
    canonical_ingredient_id: string;
    quantity: number | null;
    unit: string | null;
  }> = [];
  for (const m of plan.meals) {
    const key = `${m.day}|${m.meal_type}|${m.name}`;
    const mealId = idByKey.get(key);
    if (mealId === undefined) continue;
    for (const ing of m.ingredients) {
      ingredientRows.push({
        meal_id: mealId,
        canonical_ingredient_id: ing.canonical_id,
        quantity: ing.quantity,
        unit: ing.unit,
      });
    }
  }

  if (ingredientRows.length > 0) {
    const { error: ingErr } = await supabase
      .from('meal_ingredients')
      .insert(ingredientRows);
    if (ingErr) throw ingErr;
  }

  return { mealPlanId };
}

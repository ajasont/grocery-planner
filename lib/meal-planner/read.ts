import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';
import type {
  Day,
  MealType,
  RenderableMeal,
  RenderableDay,
  RenderablePlan,
} from './types';

const DAY_ORDER: Day[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export async function getCurrentWeekPlan(): Promise<RenderablePlan | null> {
  const supabase = getServerClient();
  const weekOf = getCurrentWeekOfISO();

  const { data: mpRow, error: mpErr } = await supabase
    .from('meal_plans')
    .select('id, week_of')
    .eq('week_of', weekOf)
    .maybeSingle();
  if (mpErr) throw mpErr;
  if (!mpRow) return null;

  const mealPlanId = mpRow.id as number;

  const { data: mealRows, error: mealErr } = await supabase
    .from('meals')
    .select(
      `id, day, meal_type, name, cuisine, cook_time_minutes, servings, notes,
       meal_ingredients (canonical_ingredient_id, quantity, unit,
         canonical_ingredients (name))`
    )
    .eq('meal_plan_id', mealPlanId);
  if (mealErr) throw mealErr;

  type Row = {
    id: number;
    day: string;
    meal_type: string;
    name: string;
    cuisine: string | null;
    cook_time_minutes: number | null;
    servings: number | null;
    notes: string | null;
    meal_ingredients: Array<{
      canonical_ingredient_id: string;
      quantity: number | null;
      unit: string | null;
      canonical_ingredients: { name: string } | null;
    }>;
  };

  const rows = ((mealRows ?? []) as unknown as Row[]).map((r): RenderableMeal => ({
    id: r.id,
    meal_type: r.meal_type as MealType,
    name: r.name,
    cuisine: r.cuisine,
    cook_time_minutes: r.cook_time_minutes,
    servings: r.servings,
    notes: r.notes,
    ingredients: (r.meal_ingredients ?? []).map((ing) => ({
      canonical_id: ing.canonical_ingredient_id,
      canonical_name: ing.canonical_ingredients?.name ?? ing.canonical_ingredient_id,
      quantity: ing.quantity,
      unit: ing.unit,
    })),
  }));

  // Attach the raw day back onto each row.
  const rowsWithDay = ((mealRows ?? []) as unknown as Row[]).map((r, i) => ({
    day: r.day as Day,
    meal: rows[i],
  }));

  const days: RenderableDay[] = DAY_ORDER.map((day) => {
    const forDay = rowsWithDay.filter((x) => x.day === day);
    const pick = (t: MealType): RenderableMeal | null =>
      forDay.find((x) => x.meal.meal_type === t)?.meal ?? null;
    return {
      day,
      breakfast: pick('breakfast'),
      lunch: pick('lunch'),
      dinner: pick('dinner'),
    };
  });

  const snacks: RenderableMeal[] = rowsWithDay
    .filter((x) => x.meal.meal_type === 'snack')
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day))
    .map((x) => x.meal);

  return {
    id: mealPlanId,
    week_of: mpRow.week_of as string,
    days,
    snacks,
  };
}

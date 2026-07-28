import type {
  GeneratedMeal,
  GeneratedPlan,
  MealType,
  Day,
} from './types';

export type ValidationResult =
  | { ok: true; plan: GeneratedPlan }
  | { ok: false; kind: 'schema' | 'sanity' | 'variety'; reason: string };

const VALID_DAYS: ReadonlySet<Day> = new Set<Day>([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const VALID_MEAL_TYPES: ReadonlySet<MealType> = new Set<MealType>([
  'breakfast',
  'lunch',
  'dinner',
  'snack',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateMealShape(m: unknown): m is GeneratedMeal {
  if (!isObject(m)) return false;
  if (typeof m.name !== 'string' || m.name.length === 0) return false;
  if (typeof m.day !== 'string' || !VALID_DAYS.has(m.day as Day)) return false;
  if (
    typeof m.meal_type !== 'string' ||
    !VALID_MEAL_TYPES.has(m.meal_type as MealType)
  )
    return false;
  if (!Array.isArray(m.ingredients)) return false;
  for (const ing of m.ingredients) {
    if (!isObject(ing)) return false;
    if (typeof ing.canonical_id !== 'string') return false;
  }
  return true;
}

export function validate(
  plan: unknown,
  canonicalIds: ReadonlySet<string>
): ValidationResult {
  // Schema
  if (!isObject(plan) || !Array.isArray(plan.meals)) {
    return { ok: false, kind: 'schema', reason: 'plan.meals must be an array' };
  }
  for (let i = 0; i < plan.meals.length; i++) {
    if (!validateMealShape(plan.meals[i])) {
      return {
        ok: false,
        kind: 'schema',
        reason: `meal at index ${i} is missing required fields`,
      };
    }
  }
  const meals = plan.meals as GeneratedMeal[];

  // Sanity — snacks are inherently short (apple + peanut butter), so
  // ≥3 ingredients only applies to breakfast/lunch/dinner.
  for (const m of meals) {
    const minIngredients = m.meal_type === 'snack' ? 1 : 3;
    if (m.ingredients.length < minIngredients) {
      return {
        ok: false,
        kind: 'sanity',
        reason: `meal "${m.name}" (${m.meal_type}) has fewer than ${minIngredients} ingredients`,
      };
    }
    if (m.cook_time_minutes !== null) {
      const minCook = m.meal_type === 'snack' ? 0 : 5;
      if (m.cook_time_minutes < minCook || m.cook_time_minutes > 120) {
        return {
          ok: false,
          kind: 'sanity',
          reason: `meal "${m.name}" (${m.meal_type}) cook time ${m.cook_time_minutes} outside [${minCook},120]`,
        };
      }
    }
    for (const ing of m.ingredients) {
      if (!canonicalIds.has(ing.canonical_id)) {
        return {
          ok: false,
          kind: 'sanity',
          reason: `unknown canonical_id "${ing.canonical_id}" in meal "${m.name}"`,
        };
      }
    }
  }

  // Variety
  const cuisineCounts = new Map<string, number>();
  for (const m of meals) {
    if (!m.cuisine) continue;
    cuisineCounts.set(m.cuisine, (cuisineCounts.get(m.cuisine) ?? 0) + 1);
  }
  const overused: string[] = [];
  cuisineCounts.forEach((count, cuisine) => {
    if (count > 2) overused.push(cuisine);
  });
  if (overused.length > 0) {
    return {
      ok: false,
      kind: 'variety',
      reason: `cuisine repeated more than twice: ${overused.join(', ')}`,
    };
  }

  return { ok: true, plan: { meals } };
}

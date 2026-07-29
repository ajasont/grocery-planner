import type {
  GeneratedMeal,
  GeneratedMealTypeChunk,
  GeneratedPlan,
  MealType,
  Day,
} from './types';

export type ChunkValidationResult =
  | { ok: true; chunk: GeneratedMealTypeChunk }
  | { ok: false; kind: 'schema' | 'sanity'; reason: string };

export type VarietyValidationResult =
  | { ok: true }
  | { ok: false; offendingCuisine: string; count: number };

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

export function validateMealTypeChunk(
  input: unknown,
  expectedMealType: MealType,
  canonicalIds: ReadonlySet<string>
): ChunkValidationResult {
  // Schema: input shape.
  if (!isObject(input) || !Array.isArray(input.meals)) {
    return { ok: false, kind: 'schema', reason: 'chunk.meals must be an array' };
  }
  const meals = input.meals;
  for (let i = 0; i < meals.length; i++) {
    if (!validateMealShape(meals[i])) {
      return {
        ok: false,
        kind: 'schema',
        reason: `meal at index ${i} is missing required fields`,
      };
    }
  }
  const typed = meals as GeneratedMeal[];

  // Sanity: day coverage — exactly one meal per day.
  if (typed.length !== 7) {
    return {
      ok: false,
      kind: 'sanity',
      reason: `expected 7 meals for ${expectedMealType} chunk, got ${typed.length}`,
    };
  }
  const seenDays = new Set<Day>();
  for (const m of typed) {
    if (seenDays.has(m.day)) {
      return {
        ok: false,
        kind: 'sanity',
        reason: `duplicate day "${m.day}" in ${expectedMealType} chunk`,
      };
    }
    seenDays.add(m.day);
  }

  // Sanity: meal_type consistency.
  for (const m of typed) {
    if (m.meal_type !== expectedMealType) {
      return {
        ok: false,
        kind: 'sanity',
        reason: `meal "${m.name}" has meal_type "${m.meal_type}", expected "${expectedMealType}"`,
      };
    }
  }

  // Sanity: ingredient counts, cook time bounds, canonical ID membership.
  for (const m of typed) {
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

  return {
    ok: true,
    chunk: { mealType: expectedMealType, meals: typed },
  };
}

export function validateVarietyAcrossPlan(
  plan: GeneratedPlan
): VarietyValidationResult {
  const counts = new Map<string, number>();
  for (const m of plan.meals) {
    if (!m.cuisine) continue;
    const key = m.cuisine.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [cuisine, count] of counts) {
    if (count > 2) {
      return { ok: false, offendingCuisine: cuisine, count };
    }
  }
  return { ok: true };
}

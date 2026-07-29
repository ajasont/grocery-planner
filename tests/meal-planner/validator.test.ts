import { describe, it, expect } from 'vitest';
import {
  validateMealTypeChunk,
  validateVarietyAcrossPlan,
} from '@/lib/meal-planner/validator';
import type { GeneratedMeal, MealType, Day } from '@/lib/meal-planner/types';

const CANONICAL_IDS = new Set([
  'chicken_breast',
  'yellow_onion',
  'garlic',
  'tomato',
  'olive_oil',
  'baby_spinach',
  'rice',
  'egg',
  'oats',
  'peanut_butter',
  'apple',
]);

const DAYS: Day[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function dinnerMeal(
  day: Day,
  overrides: Partial<GeneratedMeal> = {}
): GeneratedMeal {
  return {
    day,
    meal_type: 'dinner',
    name: `Dinner ${day}`,
    cuisine: 'american',
    cook_time_minutes: 45,
    servings: 2,
    ingredients: [
      { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
      { canonical_id: 'rice', quantity: 1, unit: 'cup' },
      { canonical_id: 'yellow_onion', quantity: 1, unit: 'each' },
    ],
    notes: null,
    ...overrides,
  };
}

function snackMeal(day: Day, overrides: Partial<GeneratedMeal> = {}): GeneratedMeal {
  return {
    day,
    meal_type: 'snack',
    name: `Snack ${day}`,
    cuisine: null,
    cook_time_minutes: 0,
    servings: 1,
    ingredients: [{ canonical_id: 'apple', quantity: 1, unit: 'each' }],
    notes: null,
    ...overrides,
  };
}

function fullDinnerChunk(): { mealType: MealType; meals: GeneratedMeal[] } {
  return { mealType: 'dinner', meals: DAYS.map((d) => dinnerMeal(d)) };
}

function fullSnackChunk(): { mealType: MealType; meals: GeneratedMeal[] } {
  return { mealType: 'snack', meals: DAYS.map((d) => snackMeal(d)) };
}

describe('validateMealTypeChunk', () => {
  it('accepts a well-formed dinner chunk (7 unique days)', () => {
    const result = validateMealTypeChunk(fullDinnerChunk(), 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed snack chunk (single-ingredient allowed)', () => {
    const result = validateMealTypeChunk(fullSnackChunk(), 'snack', CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });

  it('rejects when input is not an object with a meals array (schema)', () => {
    const result = validateMealTypeChunk('nope', 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects a meal missing required fields (schema)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [{ day: 'monday', name: 'X' }] as unknown as GeneratedMeal[],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects a chunk with fewer than 7 meals (sanity: day coverage)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: DAYS.slice(0, 6).map((d) => dinnerMeal(d)),
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/7/);
    }
  });

  it('rejects a chunk with a duplicate day (sanity: day coverage)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday'),
        dinnerMeal('monday'),
        ...DAYS.slice(2).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/monday|duplicate/i);
    }
  });

  it('rejects a meal whose meal_type disagrees with expected (sanity)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday', { meal_type: 'lunch' }),
        ...DAYS.slice(1).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/meal_type/i);
    }
  });

  it('rejects a non-snack meal with fewer than 3 ingredients (sanity)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday', {
          ingredients: [
            { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
            { canonical_id: 'rice', quantity: 1, unit: 'cup' },
          ],
        }),
        ...DAYS.slice(1).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('sanity');
  });

  it('rejects a non-snack meal with cook time under 5 (sanity)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday', { cook_time_minutes: 3 }),
        ...DAYS.slice(1).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('sanity');
  });

  it('rejects any meal with cook time over 120 (sanity)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday', { cook_time_minutes: 150 }),
        ...DAYS.slice(1).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('sanity');
  });

  it('accepts a snack with zero cook time', () => {
    const result = validateMealTypeChunk(fullSnackChunk(), 'snack', CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });

  it('rejects a snack with zero ingredients (sanity)', () => {
    const chunk = {
      mealType: 'snack' as MealType,
      meals: [
        snackMeal('monday', { ingredients: [] }),
        ...DAYS.slice(1).map((d) => snackMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'snack', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('sanity');
  });

  it('rejects a meal referencing an unknown canonical_id (sanity)', () => {
    const chunk = {
      mealType: 'dinner' as MealType,
      meals: [
        dinnerMeal('monday', {
          ingredients: [
            { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
            { canonical_id: 'rice', quantity: 1, unit: 'cup' },
            { canonical_id: 'unicorn_meat', quantity: 1, unit: 'lb' },
          ],
        }),
        ...DAYS.slice(1).map((d) => dinnerMeal(d)),
      ],
    };
    const result = validateMealTypeChunk(chunk, 'dinner', CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/unicorn_meat/);
    }
  });
});

describe('validateVarietyAcrossPlan', () => {
  function planWith(cuisines: string[]): { meals: GeneratedMeal[] } {
    // 28 meals: cycle through the given cuisines. Days repeat by design;
    // day-coverage is a per-chunk check, not a plan-level check.
    return {
      meals: cuisines.map((c, i) => ({
        day: DAYS[i % 7],
        meal_type: (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[])[
          Math.floor(i / 7) % 4
        ],
        name: `Meal ${i}`,
        cuisine: c,
        cook_time_minutes: 30,
        servings: 2,
        ingredients: [
          { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
        ],
        notes: null,
      })),
    };
  }

  it('passes when no cuisine appears more than twice', () => {
    const cuisines = [
      'italian', 'italian',
      'thai', 'thai',
      'mexican', 'mexican',
      'american', 'american',
      'greek', 'greek',
      'japanese', 'japanese',
      'indian', 'indian',
      'french',
    ];
    // Pad to 28 with empty strings; convert to null cuisines below.
    while (cuisines.length < 28) cuisines.push('');
    const plan = planWith(cuisines);
    for (const m of plan.meals) if (m.cuisine === '') m.cuisine = null;
    const result = validateVarietyAcrossPlan(plan);
    expect(result.ok).toBe(true);
  });

  it('fails when a cuisine appears 3+ times, reports which one', () => {
    const cuisines: string[] = [];
    for (let i = 0; i < 5; i++) cuisines.push('italian');
    while (cuisines.length < 28) cuisines.push('thai');
    const plan = planWith(cuisines);
    const result = validateVarietyAcrossPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.offendingCuisine).toBe('italian');
      expect(result.count).toBe(5);
    }
  });

  it('is case-insensitive when counting cuisines', () => {
    const cuisines = ['Italian', 'italian', 'ITALIAN'];
    while (cuisines.length < 28) cuisines.push('thai');
    const plan = planWith(cuisines);
    const result = validateVarietyAcrossPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offendingCuisine).toBe('italian');
  });

  it('ignores null cuisines', () => {
    const cuisines: string[] = [];
    while (cuisines.length < 28) cuisines.push('');
    const plan = planWith(cuisines);
    for (const m of plan.meals) m.cuisine = null;
    const result = validateVarietyAcrossPlan(plan);
    expect(result.ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { validate } from '@/lib/meal-planner/validator';
import type { GeneratedMeal } from '@/lib/meal-planner/types';

const CANONICAL_IDS = new Set([
  'chicken_breast',
  'yellow_onion',
  'garlic',
  'tomato',
  'olive_oil',
  'baby_spinach',
  'rice',
  'egg',
]);

function makeMeal(overrides: Partial<GeneratedMeal> = {}): GeneratedMeal {
  return {
    day: 'monday',
    meal_type: 'dinner',
    name: 'Chicken Rice Bowl',
    cuisine: 'american',
    cook_time_minutes: 30,
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

describe('validate', () => {
  it('accepts a well-formed plan', () => {
    const plan = { meals: [makeMeal()] };
    const result = validate(plan, CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });

  it('rejects a plan that is not an object with a meals array (schema)', () => {
    const result = validate({ foo: 'bar' }, CANONICAL_IDS);
    expect(result).toEqual({
      ok: false,
      kind: 'schema',
      reason: expect.stringContaining('meals'),
    });
  });

  it('rejects a meal missing required fields (schema)', () => {
    const plan = { meals: [{ day: 'monday', name: 'X' }] };
    const result = validate(plan, CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects a meal with fewer than 3 ingredients (sanity)', () => {
    const meal = makeMeal({
      ingredients: [
        { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
        { canonical_id: 'rice', quantity: 1, unit: 'cup' },
      ],
    });
    const result = validate({ meals: [meal] }, CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/3 ingredients/i);
    }
  });

  it('rejects a meal with cook time out of [5,120] range (sanity)', () => {
    const meal = makeMeal({ cook_time_minutes: 3 });
    const result = validate({ meals: [meal] }, CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('sanity');
  });

  it('rejects a meal referencing an unknown canonical_id (sanity)', () => {
    const meal = makeMeal({
      ingredients: [
        { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
        { canonical_id: 'rice', quantity: 1, unit: 'cup' },
        { canonical_id: 'unicorn_meat', quantity: 1, unit: 'lb' },
      ],
    });
    const result = validate({ meals: [meal] }, CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('sanity');
      expect(result.reason).toMatch(/unicorn_meat/);
    }
  });

  it('flags cuisine repeats greater than twice per week (variety)', () => {
    const meals = [
      makeMeal({ day: 'monday', cuisine: 'italian' }),
      makeMeal({ day: 'tuesday', cuisine: 'italian' }),
      makeMeal({ day: 'wednesday', cuisine: 'italian' }),
    ];
    const result = validate({ meals }, CANONICAL_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('variety');
      expect(result.reason).toMatch(/italian/);
    }
  });

  it('does not flag variety when a cuisine appears exactly twice', () => {
    const meals = [
      makeMeal({ day: 'monday', cuisine: 'italian' }),
      makeMeal({ day: 'tuesday', cuisine: 'italian' }),
    ];
    const result = validate({ meals }, CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });

  it('ignores null cuisine when counting variety', () => {
    const meals = [
      makeMeal({ day: 'monday', cuisine: null }),
      makeMeal({ day: 'tuesday', cuisine: null }),
      makeMeal({ day: 'wednesday', cuisine: null }),
    ];
    const result = validate({ meals }, CANONICAL_IDS);
    expect(result.ok).toBe(true);
  });
});

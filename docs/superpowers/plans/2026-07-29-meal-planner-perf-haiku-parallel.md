# Meal Planner Perf: Haiku 4.5 + Parallel by Meal Type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **When implementing Task 4 (the generator rewrite):** Invoke the `claude-api` skill first if available. It covers current Anthropic SDK patterns, prompt caching, tool-use, and the Haiku 4.5 model ID.

**Goal:** Cut `POST /api/plan/generate` wall-clock from ~130s to <20s by (a) swapping Sonnet 4.6 for Haiku 4.5 and (b) fanning the single 28-meal call out into four concurrent per-meal-type calls that are merged, variety-validated, and repaired on failure.

**Architecture:** No new files. `lib/meal-planner/{types,prompt,validator,generate}.ts` are edited in place. `generatePlan` becomes an orchestrator that runs four `generateMealType` calls under `Promise.all`, merges the four 7-meal chunks into a `GeneratedPlan`, checks cross-cut cuisine variety, and repairs a single chunk on failure. Everything downstream (`persist.ts`, `read.ts`, `/api/plan/generate/route.ts`, `/plan` UI, DB schema) is unchanged.

**Tech Stack:** Next.js 14 App Router (TypeScript), Supabase (Postgres), Anthropic SDK (Haiku 4.5, model id `claude-haiku-4-5-20251001`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-meal-planner-perf-haiku-parallel.md`

---

## File Structure

**Modified files (source):**

- `lib/meal-planner/types.ts` — add `GeneratedMealTypeChunk` type.
- `lib/meal-planner/validator.ts` — replace `validate()` with `validateMealTypeChunk()` + `validateVarietyAcrossPlan()`. Remove the combined `validate()` API and its `enforceVariety` flag.
- `lib/meal-planner/prompt.ts` — replace `buildPrompt()` + `GENERATE_TOOL` with `buildMealTypePrompt(mealType, input)` returning the trimmed system prompt and a per-meal-type narrowed tool schema.
- `lib/meal-planner/generate.ts` — set `MODEL` to `claude-haiku-4-5-20251001`, add `generateMealType`, rewrite `generatePlan` as the parallel orchestrator + repair path.

**Modified files (tests):**

- `tests/meal-planner/validator.test.ts` — cover the two new functions; drop tests for the deleted `validate()` API.
- `tests/meal-planner/prompt.test.ts` — cover per-meal-type trimming and narrowed tool schema.
- `tests/meal-planner/generate.test.ts` — cover parallel happy path, per-chunk JSON retry, per-chunk validation failure, variety repair, and repair failure.

**Unchanged:** `lib/meal-planner/inputs.ts`, `lib/meal-planner/persist.ts`, `lib/meal-planner/read.ts`, `lib/dates.ts`, `lib/db/client.ts`, `lib/anthropic/client.ts`, `app/api/plan/generate/route.ts`, `app/plan/*`, DB schema, `tests/meal-planner/inputs.test.ts`.

**Deviation from spec:** `validateMealTypeChunk` deliberately does NOT enforce prior-meal-name avoidance. The v1 `validate()` never checked it — prior-meal avoidance has always been a prompt-side hint — and turning it into a hard rejection risks user-visible errors when Haiku happens to name a common dish that was in the last three weeks. Prior-meal names are still passed into the prompt as before.

---

## Task 1: Add `GeneratedMealTypeChunk` type

Small, unblocks the validator and generator rewrites. No behavior change yet.

**Files:**
- Modify: `lib/meal-planner/types.ts`

- [ ] **Step 1: Add the type**

Open `lib/meal-planner/types.ts`. After the existing `GeneratedPlan` type (around line 63), add:

```typescript
// Intermediate shape: one meal_type's chunk returned by a single generateMealType call.
export type GeneratedMealTypeChunk = {
  mealType: MealType;
  meals: GeneratedMeal[];
};
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner add lib/meal-planner/types.ts
git -C /Users/jasonlee/Documents/Coding/grocery-planner commit -m "Add GeneratedMealTypeChunk type for per-meal-type chunks"
```

---

## Task 2: Split the validator

Replace the monolithic `validate()` with `validateMealTypeChunk()` and `validateVarietyAcrossPlan()`. TDD: write the new test file, then implement.

**Files:**
- Modify: `lib/meal-planner/validator.ts`
- Modify: `tests/meal-planner/validator.test.ts`

- [ ] **Step 1: Rewrite the validator test file**

Replace the entire contents of `tests/meal-planner/validator.test.ts` with:

```typescript
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
    // Pad to 28 with nulls stringified; use null-safe branch:
    while (cuisines.length < 28) cuisines.push('');
    const plan = planWith(cuisines);
    // Replace empty strings with real null cuisines:
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/validator.test.ts`
Expected: all tests fail — imports don't resolve (`validateMealTypeChunk`, `validateVarietyAcrossPlan` don't exist yet).

- [ ] **Step 3: Rewrite `lib/meal-planner/validator.ts`**

Replace the entire contents of `lib/meal-planner/validator.ts` with:

```typescript
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
  let worst: { cuisine: string; count: number } | null = null;
  counts.forEach((count, cuisine) => {
    if (count <= 2) return;
    if (!worst || count > worst.count) worst = { cuisine, count };
  });
  if (worst) {
    return {
      ok: false,
      offendingCuisine: (worst as { cuisine: string; count: number }).cuisine,
      count: (worst as { cuisine: string; count: number }).count,
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/validator.test.ts`
Expected: all validator tests PASS. Other test files (`generate.test.ts`, `prompt.test.ts`) will still fail because they import the deleted `validate` / `buildPrompt`; that's fine — those get fixed in Tasks 3 and 4.

- [ ] **Step 5: Commit**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner add lib/meal-planner/validator.ts tests/meal-planner/validator.test.ts
git -C /Users/jasonlee/Documents/Coding/grocery-planner commit -m "Split validator into per-chunk + across-plan variety functions"
```

---

## Task 3: Rewrite prompt builder per meal type

Replace `buildPrompt` + monolithic `GENERATE_TOOL` with `buildMealTypePrompt(mealType, input)` that returns a trimmed per-type system prompt and a narrowed tool schema.

**Files:**
- Modify: `lib/meal-planner/prompt.ts`
- Modify: `tests/meal-planner/prompt.test.ts`

- [ ] **Step 1: Rewrite the prompt test file**

Replace the entire contents of `tests/meal-planner/prompt.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { buildMealTypePrompt } from '@/lib/meal-planner/prompt';
import type { PlannerInput, MealType } from '@/lib/meal-planner/types';

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    deals: [
      {
        canonical_id: 'chicken_breast',
        canonical_name: 'Chicken Breast',
        category: 'meat',
        cheapest_retailer: 'harris-teeter',
        sale_price: 3.49,
      },
      {
        canonical_id: 'baby_spinach',
        canonical_name: 'Baby Spinach',
        category: 'produce',
        cheapest_retailer: 'sprouts',
        sale_price: 2.99,
      },
    ],
    pantry: [{ canonical_id: 'olive_oil', canonical_name: 'Olive Oil' }],
    preferences: {
      dietary_flags: [],
      disliked_ingredients: [],
      liked_ingredients: [],
      disliked_cuisines: [],
      liked_cuisines: [],
    },
    prior_meal_names: ['Chicken Tikka Masala', 'Sheet-pan Salmon'],
    ...overrides,
  };
}

const ALL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

describe('buildMealTypePrompt — shared behavior across all meal types', () => {
  for (const t of ALL_TYPES) {
    it(`${t}: user turn lists deals with canonical name, retailer, price`, () => {
      const { userText } = buildMealTypePrompt(t, baseInput());
      expect(userText).toContain('Chicken Breast');
      expect(userText).toContain('harris-teeter');
      expect(userText).toContain('3.49');
    });

    it(`${t}: user turn lists pantry items`, () => {
      const { userText } = buildMealTypePrompt(t, baseInput());
      expect(userText).toMatch(/pantry/i);
      expect(userText).toContain('Olive Oil');
    });

    it(`${t}: user turn lists prior meal names to avoid`, () => {
      const { userText } = buildMealTypePrompt(t, baseInput());
      expect(userText).toMatch(/avoid|do not repeat|last.*weeks/i);
      expect(userText).toContain('Chicken Tikka Masala');
    });

    it(`${t}: system prompt mentions cuisine variety guidance`, () => {
      const { system } = buildMealTypePrompt(t, baseInput());
      expect(system).toMatch(/cuisine.*more than twice/i);
    });

    it(`${t}: system prompt is short (< 1500 chars)`, () => {
      const { system } = buildMealTypePrompt(t, baseInput());
      expect(system.length).toBeLessThan(1500);
    });

    it(`${t}: tool is generate_meal_plan and requires exactly 7 meals`, () => {
      const { tool } = buildMealTypePrompt(t, baseInput());
      expect(tool.name).toBe('generate_meal_plan');
      const mealsSchema = (tool.input_schema.properties as Record<string, unknown>)
        .meals as Record<string, unknown>;
      expect(mealsSchema.minItems).toBe(7);
      expect(mealsSchema.maxItems).toBe(7);
    });

    it(`${t}: tool schema pins meal_type to the requested type`, () => {
      const { tool } = buildMealTypePrompt(t, baseInput());
      const mealsSchema = (tool.input_schema.properties as Record<string, unknown>)
        .meals as { items: { properties: { meal_type: { enum: string[] } } } };
      expect(mealsSchema.items.properties.meal_type.enum).toEqual([t]);
    });
  }
});

describe('buildMealTypePrompt — dinner-specific rules', () => {
  it('dinner: system prompt has weeknight cook-time budget', () => {
    const { system } = buildMealTypePrompt('dinner', baseInput());
    expect(system).toMatch(/weeknight/i);
    expect(system).toMatch(/30.*60/);
  });

  it('dinner: system prompt requires >= 3 ingredients', () => {
    const { system } = buildMealTypePrompt('dinner', baseInput());
    expect(system).toMatch(/3 ingredients/i);
  });
});

describe('buildMealTypePrompt — breakfast/lunch keep >=3 ingredients, no dinner cook-time rule', () => {
  for (const t of ['breakfast', 'lunch'] as MealType[]) {
    it(`${t}: system prompt requires >= 3 ingredients`, () => {
      const { system } = buildMealTypePrompt(t, baseInput());
      expect(system).toMatch(/3 ingredients/i);
    });

    it(`${t}: system prompt does NOT mention the weeknight 30-60 dinner rule`, () => {
      const { system } = buildMealTypePrompt(t, baseInput());
      expect(system).not.toMatch(/weeknight/i);
    });
  }
});

describe('buildMealTypePrompt — snack-specific rules', () => {
  it('snack: system prompt allows 1-2 ingredients', () => {
    const { system } = buildMealTypePrompt('snack', baseInput());
    expect(system).toMatch(/1.*2 ingredients/i);
  });

  it('snack: system prompt allows 0 cook time', () => {
    const { system } = buildMealTypePrompt('snack', baseInput());
    expect(system).toMatch(/0/); // "cook_time_minutes: 0 if no cooking is needed"
  });

  it('snack: system prompt does NOT require >= 3 ingredients', () => {
    const { system } = buildMealTypePrompt('snack', baseInput());
    expect(system).not.toMatch(/3 ingredients/i);
  });
});

describe('buildMealTypePrompt — edge cases', () => {
  it('renders empty pantry / empty prior meals without "undefined"', () => {
    const { userText } = buildMealTypePrompt(
      'dinner',
      baseInput({ pantry: [], prior_meal_names: [] })
    );
    expect(userText).not.toContain('undefined');
    expect(userText.length).toBeGreaterThan(0);
  });

  it('includes preferences when non-empty', () => {
    const { userText } = buildMealTypePrompt(
      'dinner',
      baseInput({
        preferences: {
          dietary_flags: ['vegetarian'],
          disliked_ingredients: ['cilantro'],
          liked_ingredients: [],
          disliked_cuisines: [],
          liked_cuisines: ['thai'],
        },
      })
    );
    expect(userText).toMatch(/vegetarian/);
    expect(userText).toMatch(/cilantro/);
    expect(userText).toMatch(/thai/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/prompt.test.ts`
Expected: all tests fail — `buildMealTypePrompt` doesn't exist yet.

- [ ] **Step 3: Rewrite `lib/meal-planner/prompt.ts`**

Replace the entire contents of `lib/meal-planner/prompt.ts` with:

```typescript
import type { MealType, PlannerInput } from './types';

function mealTypeConstraints(mealType: MealType): string {
  switch (mealType) {
    case 'breakfast':
      return `- Output exactly 7 breakfasts, one per day (monday through sunday). No day may repeat.
- Each breakfast needs at least 3 ingredients.
- cook_time_minutes: 5-120.`;
    case 'lunch':
      return `- Output exactly 7 lunches, one per day (monday through sunday). No day may repeat.
- Each lunch needs at least 3 ingredients.
- cook_time_minutes: 5-120.`;
    case 'dinner':
      return `- Output exactly 7 dinners, one per day (monday through sunday). No day may repeat.
- Each dinner needs at least 3 ingredients.
- Weeknight dinners (mon-fri): 30-60 minutes of cook time. Weekend dinners (sat, sun) may go longer, up to 120.
- cook_time_minutes: 5-120.`;
    case 'snack':
      return `- Output exactly 7 snacks, one per day (monday through sunday). No day may repeat.
- Snacks may have 1-2 ingredients (e.g., apple + peanut butter).
- cook_time_minutes: 0 if no cooking is needed, otherwise up to 120.`;
  }
}

function buildSystemPrompt(mealType: MealType): string {
  return `You are a meal planner for a household of 2 adults in Baltimore. \
Generate the ${mealType} slot of a weekly meal plan from a list of on-sale ingredients.

Constraints for this ${mealType} chunk:
${mealTypeConstraints(mealType)}

Constraints that apply to the full week (they will be validated after all four meal-type chunks are merged, so respect them here):
- No cuisine may appear more than twice across the week.
- Prefer well-known named recipes (dishes a home cook would recognize) over invented ones.
- Prefer meals that use ingredients from the "available on sale" list.
- Every ingredient must reference a canonical_id from the "available on sale" or pantry lists (do not invent new IDs).
- Do not repeat any meal name from the "recent meals to avoid" list.
- Respect household preferences: honor dietary_flags, exclude disliked ingredients and cuisines, bias toward liked ones.

Return the 7 ${mealType} meals via the generate_meal_plan tool.`;
}

function buildTool(mealType: MealType) {
  return {
    name: 'generate_meal_plan',
    description: `Emit the 7 ${mealType} meals for the week (one per day).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        meals: {
          type: 'array' as const,
          minItems: 7,
          maxItems: 7,
          items: {
            type: 'object' as const,
            properties: {
              day: {
                type: 'string' as const,
                enum: [
                  'monday',
                  'tuesday',
                  'wednesday',
                  'thursday',
                  'friday',
                  'saturday',
                  'sunday',
                ],
              },
              meal_type: {
                type: 'string' as const,
                enum: [mealType],
              },
              name: { type: 'string' as const },
              cuisine: { type: ['string', 'null'] as const },
              cook_time_minutes: { type: ['integer', 'null'] as const },
              servings: { type: ['integer', 'null'] as const },
              ingredients: {
                type: 'array' as const,
                items: {
                  type: 'object' as const,
                  properties: {
                    canonical_id: { type: 'string' as const },
                    quantity: { type: ['number', 'null'] as const },
                    unit: { type: ['string', 'null'] as const },
                  },
                  required: ['canonical_id'],
                },
              },
              notes: { type: ['string', 'null'] as const },
            },
            required: ['day', 'meal_type', 'name', 'ingredients'],
          },
        },
      },
      required: ['meals'],
    },
  };
}

function renderDeals(deals: PlannerInput['deals']): string {
  if (deals.length === 0) return '(none — no deals loaded this week)';
  return deals
    .map(
      (d) =>
        `- ${d.canonical_id} (${d.canonical_name}) — $${d.sale_price.toFixed(2)} at ${d.cheapest_retailer}`
    )
    .join('\n');
}

function renderPantry(pantry: PlannerInput['pantry']): string {
  if (pantry.length === 0) return '(empty)';
  return pantry.map((p) => `- ${p.canonical_id} (${p.canonical_name})`).join('\n');
}

function renderPriorMeals(names: string[]): string {
  if (names.length === 0) return '(no prior meals — this is the first week)';
  return names.map((n) => `- ${n}`).join('\n');
}

function renderPreferences(prefs: PlannerInput['preferences']): string {
  const parts: string[] = [];
  if (prefs.dietary_flags.length > 0)
    parts.push(`Dietary flags: ${prefs.dietary_flags.join(', ')}`);
  if (prefs.disliked_ingredients.length > 0)
    parts.push(`Disliked ingredients: ${prefs.disliked_ingredients.join(', ')}`);
  if (prefs.disliked_cuisines.length > 0)
    parts.push(`Disliked cuisines: ${prefs.disliked_cuisines.join(', ')}`);
  if (prefs.liked_ingredients.length > 0)
    parts.push(`Liked ingredients: ${prefs.liked_ingredients.join(', ')}`);
  if (prefs.liked_cuisines.length > 0)
    parts.push(`Liked cuisines: ${prefs.liked_cuisines.join(', ')}`);
  return parts.length > 0 ? parts.join('\n') : '(no preferences set)';
}

export type BuiltPrompt = {
  system: string;
  userText: string;
  tool: ReturnType<typeof buildTool>;
};

export function buildMealTypePrompt(
  mealType: MealType,
  input: PlannerInput,
  extraUserInstructions?: string
): BuiltPrompt {
  const userTextParts = [
    'Available on sale this week:',
    renderDeals(input.deals),
    '',
    'Pantry (already have):',
    renderPantry(input.pantry),
    '',
    'Household preferences:',
    renderPreferences(input.preferences),
    '',
    'Recent meals to avoid (last 3 weeks):',
    renderPriorMeals(input.prior_meal_names),
    '',
    `Generate the 7 ${mealType} meals now via the generate_meal_plan tool.`,
  ];
  if (extraUserInstructions && extraUserInstructions.length > 0) {
    userTextParts.push('', extraUserInstructions);
  }
  return {
    system: buildSystemPrompt(mealType),
    userText: userTextParts.join('\n'),
    tool: buildTool(mealType),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/prompt.test.ts`
Expected: all prompt tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner add lib/meal-planner/prompt.ts tests/meal-planner/prompt.test.ts
git -C /Users/jasonlee/Documents/Coding/grocery-planner commit -m "Split prompt builder per meal type with narrowed tool schema"
```

---

## Task 4: Rewrite `generate.ts` — Haiku, parallel, variety repair

Rewrite `generatePlan` to fan out into four `generateMealType` calls, merge them, validate cross-cut variety, and repair a single chunk on failure.

**Files:**
- Modify: `lib/meal-planner/generate.ts`
- Modify: `tests/meal-planner/generate.test.ts`

- [ ] **Step 1: Rewrite the generate test file**

Replace the entire contents of `tests/meal-planner/generate.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { generatePlan } from '@/lib/meal-planner/generate';
import type {
  PlannerInput,
  GeneratedMeal,
  MealType,
  Day,
} from '@/lib/meal-planner/types';
import { ValidationError, JsonParseError } from '@/lib/meal-planner/types';

const DAYS: Day[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const CANONICAL_IDS = new Set([
  'chicken_breast',
  'rice',
  'yellow_onion',
  'oats',
  'egg',
  'apple',
]);

function baseInput(): PlannerInput {
  return {
    deals: [
      {
        canonical_id: 'chicken_breast',
        canonical_name: 'Chicken Breast',
        category: 'meat',
        cheapest_retailer: 'harris-teeter',
        sale_price: 3.49,
      },
    ],
    pantry: [],
    preferences: {
      dietary_flags: [],
      disliked_ingredients: [],
      liked_ingredients: [],
      disliked_cuisines: [],
      liked_cuisines: [],
    },
    prior_meal_names: [],
  };
}

function meal(
  mealType: MealType,
  day: Day,
  overrides: Partial<GeneratedMeal> = {}
): GeneratedMeal {
  const isSnack = mealType === 'snack';
  return {
    day,
    meal_type: mealType,
    name: `${mealType} ${day}`,
    cuisine: 'american',
    cook_time_minutes: isSnack ? 0 : 30,
    servings: 2,
    ingredients: isSnack
      ? [{ canonical_id: 'apple', quantity: 1, unit: 'each' }]
      : [
          { canonical_id: 'chicken_breast', quantity: 1, unit: 'lb' },
          { canonical_id: 'rice', quantity: 1, unit: 'cup' },
          { canonical_id: 'yellow_onion', quantity: 1, unit: 'each' },
        ],
    notes: null,
    ...overrides,
  };
}

function fullChunk(
  mealType: MealType,
  overrides?: (day: Day, idx: number) => Partial<GeneratedMeal>
) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'generate_meal_plan',
        input: {
          meals: DAYS.map((d, i) =>
            meal(mealType, d, overrides ? overrides(d, i) : {})
          ),
        },
      },
    ],
  };
}

function chunkFor(mealType: MealType) {
  // Helper to filter which call the mock is answering. In tests we sequence
  // mockCreate.mockResolvedValueOnce in the order breakfast, lunch, dinner, snack,
  // but Promise.all does not guarantee call order — the generator instead
  // dispatches all four synchronously, so mock queueing by index is unreliable.
  // We instead identify by inspecting the system-prompt content of the request.
  return fullChunk(mealType);
}

function replyWithChunkByRequest(
  request: unknown
): { content: Array<{ type: string; name?: string; input?: unknown }> } {
  const req = request as {
    system: Array<{ text: string }>;
  };
  const sys = req.system[0].text;
  const mealType: MealType = (
    ['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]
  ).find((t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)) ?? 'dinner';
  return fullChunk(mealType);
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('generatePlan — happy path', () => {
  it('makes exactly 4 concurrent calls and merges into 28 meals', async () => {
    mockCreate.mockImplementation(async (req) => replyWithChunkByRequest(req));
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
    expect(mockCreate).toHaveBeenCalledTimes(4);
    const seen = new Set(plan.meals.map((m) => `${m.meal_type}/${m.day}`));
    expect(seen.size).toBe(28);
  });

  it('uses Haiku 4.5 model id', async () => {
    mockCreate.mockImplementation(async (req) => replyWithChunkByRequest(req));
    await generatePlan(baseInput(), CANONICAL_IDS);
    const firstCallArg = mockCreate.mock.calls[0][0];
    expect(firstCallArg.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('generatePlan — JSON parse retry', () => {
  it('silently retries one chunk on missing tool_use, then succeeds', async () => {
    const seenTypes = new Set<string>();
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      // First time we see dinner: return no-tool. Every other call: return normal chunk.
      if (mealType === 'dinner' && !seenTypes.has('dinner')) {
        seenTypes.add('dinner');
        return { content: [{ type: 'text', text: 'no tool here' }] };
      }
      return fullChunk(mealType);
    });
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
    // 4 initial + 1 dinner retry
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('throws JsonParseError after two attempts on the same chunk', async () => {
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'dinner') {
        return { content: [{ type: 'text', text: 'no tool here' }] };
      }
      return fullChunk(mealType);
    });
    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      JsonParseError
    );
  });
});

describe('generatePlan — per-chunk validation failure', () => {
  it('throws ValidationError when a chunk returns fewer than 7 meals', async () => {
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'lunch') {
        return {
          content: [
            {
              type: 'tool_use',
              name: 'generate_meal_plan',
              input: { meals: DAYS.slice(0, 6).map((d) => meal('lunch', d)) },
            },
          ],
        };
      }
      return fullChunk(mealType);
    });
    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe('generatePlan — variety repair', () => {
  it('fires one targeted repair call when a cuisine appears 3+ times', async () => {
    let dinnerCallCount = 0;
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'dinner') {
        dinnerCallCount++;
        if (dinnerCallCount === 1) {
          // First dinner call: overload italian (5x).
          return fullChunk('dinner', (_d, i) => ({
            cuisine: i < 5 ? 'italian' : 'thai',
          }));
        }
        // Repair call: reset cuisines.
        return fullChunk('dinner', () => ({ cuisine: 'thai' }));
      }
      return fullChunk(mealType);
    });
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
    expect(dinnerCallCount).toBe(2);
    // After repair, no italian.
    const italianCount = plan.meals.filter(
      (m) => m.cuisine?.toLowerCase() === 'italian'
    ).length;
    expect(italianCount).toBe(0);
  });

  it('repair call user prompt includes a disallow-cuisine instruction', async () => {
    let dinnerCallCount = 0;
    let repairUserText = '';
    mockCreate.mockImplementation(async (req) => {
      const typedReq = req as {
        system: Array<{ text: string }>;
        messages: Array<{ role: string; content: string }>;
      };
      const sys = typedReq.system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'dinner') {
        dinnerCallCount++;
        if (dinnerCallCount === 1) {
          return fullChunk('dinner', (_d, i) => ({
            cuisine: i < 5 ? 'italian' : 'thai',
          }));
        }
        repairUserText = typedReq.messages[0].content;
        return fullChunk('dinner', () => ({ cuisine: 'greek' }));
      }
      return fullChunk(mealType);
    });
    await generatePlan(baseInput(), CANONICAL_IDS);
    expect(repairUserText).toMatch(/italian/i);
    expect(repairUserText).toMatch(/do not use/i);
  });

  it('accepts a repair result even if variety still fails (matches v1 retry semantics)', async () => {
    let dinnerCallCount = 0;
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'dinner') {
        dinnerCallCount++;
        // Both dinner calls: 5x italian. Repair result still violates variety.
        return fullChunk('dinner', (_d, i) => ({
          cuisine: i < 5 ? 'italian' : 'thai',
        }));
      }
      return fullChunk(mealType);
    });
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
    expect(dinnerCallCount).toBe(2);
  });

  it('propagates ValidationError if repair chunk is structurally invalid', async () => {
    let dinnerCallCount = 0;
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'dinner') {
        dinnerCallCount++;
        if (dinnerCallCount === 1) {
          return fullChunk('dinner', (_d, i) => ({
            cuisine: i < 5 ? 'italian' : 'thai',
          }));
        }
        // Repair: return 5 meals instead of 7.
        return {
          content: [
            {
              type: 'tool_use',
              name: 'generate_meal_plan',
              input: { meals: DAYS.slice(0, 5).map((d) => meal('dinner', d)) },
            },
          ],
        };
      }
      return fullChunk(mealType);
    });
    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/generate.test.ts`
Expected: all tests fail — the new generator behavior isn't implemented yet.

- [ ] **Step 3: Rewrite `lib/meal-planner/generate.ts`**

Replace the entire contents of `lib/meal-planner/generate.ts` with:

```typescript
import { getAnthropicClient } from '@/lib/anthropic/client';
import { buildMealTypePrompt } from './prompt';
import {
  validateMealTypeChunk,
  validateVarietyAcrossPlan,
} from './validator';
import {
  AnthropicError,
  JsonParseError,
  ValidationError,
  type GeneratedMealTypeChunk,
  type GeneratedPlan,
  type MealType,
  type PlannerInput,
} from './types';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractToolInput(content: any[]): unknown | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUse = (content as any[]).find(
    (b) => b?.type === 'tool_use' && b?.name === 'generate_meal_plan'
  );
  return toolUse ? (toolUse.input ?? null) : null;
}

async function callHaikuRaw(
  system: string,
  userText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any
): Promise<unknown> {
  const client = getAnthropicClient();
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } } as any,
      ],
      messages: [{ role: 'user', content: userText }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'generate_meal_plan' },
    });
  } catch (err) {
    throw new AnthropicError(String(err));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = extractToolInput((response as any).content);
  if (input === null) {
    throw new JsonParseError(
      'Haiku returned no generate_meal_plan tool_use block'
    );
  }
  return input;
}

async function callHaikuWithRetry(
  system: string,
  userText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any
): Promise<unknown> {
  try {
    return await callHaikuRaw(system, userText, tool);
  } catch (err) {
    if (err instanceof JsonParseError) {
      return await callHaikuRaw(system, userText, tool);
    }
    throw err;
  }
}

async function generateMealType(
  mealType: MealType,
  input: PlannerInput,
  canonicalIds: ReadonlySet<string>,
  extraUserInstructions?: string
): Promise<GeneratedMealTypeChunk> {
  const { system, userText, tool } = buildMealTypePrompt(
    mealType,
    input,
    extraUserInstructions
  );
  const raw = await callHaikuWithRetry(system, userText, tool);
  const result = validateMealTypeChunk(raw, mealType, canonicalIds);
  if (!result.ok) {
    throw new ValidationError(result.reason, result.kind);
  }
  return result.chunk;
}

function mergeChunks(chunks: GeneratedMealTypeChunk[]): GeneratedPlan {
  return { meals: chunks.flatMap((c) => c.meals) };
}

function pickRepairTarget(
  chunks: GeneratedMealTypeChunk[],
  offendingCuisine: string
): MealType {
  // Meal type contributing the most instances of the offending cuisine wins.
  let best = { mealType: chunks[0].mealType, count: -1 };
  for (const chunk of chunks) {
    const count = chunk.meals.filter(
      (m) => m.cuisine?.toLowerCase() === offendingCuisine
    ).length;
    if (count > best.count) best = { mealType: chunk.mealType, count };
  }
  return best.mealType;
}

function otherMealNames(
  chunks: GeneratedMealTypeChunk[],
  excludeMealType: MealType
): string[] {
  return chunks
    .filter((c) => c.mealType !== excludeMealType)
    .flatMap((c) => c.meals.map((m) => m.name));
}

export async function generatePlan(
  input: PlannerInput,
  canonicalIds: ReadonlySet<string>
): Promise<GeneratedPlan> {
  const chunks = await Promise.all(
    MEAL_TYPES.map((t) => generateMealType(t, input, canonicalIds))
  );

  const merged = mergeChunks(chunks);
  const varietyResult = validateVarietyAcrossPlan(merged);
  if (varietyResult.ok) return merged;

  // Cross-cut variety failure — repair a single chunk.
  const target = pickRepairTarget(chunks, varietyResult.offendingCuisine);
  const disallow = varietyResult.offendingCuisine;
  const dontRepeat = otherMealNames(chunks, target);
  const repairInstructions = [
    `Do not use cuisine "${disallow}" for any meal in this chunk (it was overused in the previous attempt across the full week).`,
    dontRepeat.length > 0
      ? `Do not repeat any of these meal names from the other meal types in this week's plan:\n${dontRepeat.map((n) => `- ${n}`).join('\n')}`
      : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  const repaired = await generateMealType(
    target,
    input,
    canonicalIds,
    repairInstructions
  );

  const finalChunks = chunks.map((c) => (c.mealType === target ? repaired : c));
  return mergeChunks(finalChunks);
}
```

- [ ] **Step 4: Run the generator tests to verify they pass**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/generate.test.ts`
Expected: all generator tests PASS.

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npm test`
Expected: all tests pass (validator, prompt, generate, inputs, plus any other tests in the repo). No failures.

- [ ] **Step 6: Type-check**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner add lib/meal-planner/generate.ts tests/meal-planner/generate.test.ts
git -C /Users/jasonlee/Documents/Coding/grocery-planner commit -m "Rewrite generatePlan with Haiku 4.5, per-meal-type parallelism, and variety repair"
```

---

## Task 5: Local smoke test with wall-clock measurement

Verify the change actually hits the ≤20s target end-to-end against the real Anthropic API, and confirm the /plan UI still renders correctly.

**Files:** none modified in this task; this is verification.

- [ ] **Step 1: Confirm `.env.local` has the needed keys**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && grep -E '^(ANTHROPIC_API_KEY|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SHARED_PASSWORD|SESSION_SECRET)=' .env.local | awk -F= '{print $1}'`
Expected: all five variable names print. (Do NOT log or paste the values.)

- [ ] **Step 2: Start the dev server**

In one terminal: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npm run dev`
Expected: server listening on http://localhost:3000.

- [ ] **Step 3: Log into the app and open /plan**

Open http://localhost:3000, log in with `SHARED_PASSWORD`, navigate to /plan.
Expected: either the existing plan renders, or the empty state with "Plan my week" button. (If a plan already exists, click "Regenerate" — this exercises the same POST endpoint.)

- [ ] **Step 4: Trigger generation and measure wall-clock**

Click the generate/regenerate button. In the dev-server terminal, note the log line for `POST /api/plan/generate ... in XXXXms`.
Expected: XXX < 20000. Soft ceiling: 30000 (if repair fired).

- [ ] **Step 5: Verify the populated /plan view**

After redirect, /plan should render the day accordion with today expanded, 28 meals total (4 per day), all with named recipes and ingredient lists. No error banner. No "unknown canonical_id" spot-checks needed — validation would have failed.

- [ ] **Step 6: Manual quality spot-check**

Read through one day's four meals:
- All ingredients resolve to canonical names.
- Cook times sane per type (dinner mon-fri ≤ 60, weekend up to 120; snacks 0-120; breakfast/lunch 5-120).
- No repeated meal names across the week (spot-check a few).
- No cuisine visibly dominating (≤ 2 per cuisine).

If quality looks acceptable, proceed. If it doesn't (e.g., meals feel invented rather than recognizable, or ingredient use is nonsensical), fall back to the rollback plan (Task 6 note below).

- [ ] **Step 7: Stop the dev server**

Ctrl+C in the dev-server terminal.

- [ ] **Step 8: Hand off to finishing-a-development-branch skill**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
Invoke `superpowers:finishing-a-development-branch`.

---

## Rollback plan (only if Task 5 quality check fails)

If Haiku 4.5 produces unacceptable meal quality (subjective judgment after ≥2 real generations), keep the parallel structure but revert the model. Change one line in `lib/meal-planner/generate.ts`:

```typescript
const MODEL = 'claude-sonnet-4-6';
```

Expected wall-clock in this fallback: ~35-50s. Still a large improvement over v1's 130s; misses the ≤20s target but preserves quality. Commit and note the tradeoff in the memory update.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { generatePlan } from '@/lib/meal-planner/generate';
import type { PlannerInput, GeneratedMeal } from '@/lib/meal-planner/types';
import { ValidationError, JsonParseError } from '@/lib/meal-planner/types';

const CANONICAL_IDS = new Set(['chicken_breast', 'rice', 'yellow_onion']);

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

function meal(overrides: Partial<GeneratedMeal> = {}): GeneratedMeal {
  return {
    day: 'monday',
    meal_type: 'dinner',
    name: 'Test Meal',
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

function toolResponse(meals: GeneratedMeal[]) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'generate_meal_plan',
        input: { meals },
      },
    ],
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('generatePlan', () => {
  it('returns a validated plan on happy path', async () => {
    mockCreate.mockResolvedValueOnce(toolResponse([meal()]));
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(1);
    expect(plan.meals[0].name).toBe('Test Meal');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('re-prompts once on variety failure and accepts the second attempt', async () => {
    // First attempt: 3x italian (variety fail).
    mockCreate.mockResolvedValueOnce(
      toolResponse([
        meal({ day: 'monday', cuisine: 'italian' }),
        meal({ day: 'tuesday', cuisine: 'italian' }),
        meal({ day: 'wednesday', cuisine: 'italian' }),
      ])
    );
    // Second attempt: valid variety.
    mockCreate.mockResolvedValueOnce(
      toolResponse([
        meal({ day: 'monday', cuisine: 'italian' }),
        meal({ day: 'tuesday', cuisine: 'thai' }),
      ])
    );
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('accepts a borderline second attempt even if variety still fails', async () => {
    const bad = toolResponse([
      meal({ day: 'monday', cuisine: 'italian' }),
      meal({ day: 'tuesday', cuisine: 'italian' }),
      meal({ day: 'wednesday', cuisine: 'italian' }),
    ]);
    mockCreate.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad);
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(3);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws ValidationError on sanity failure without retry', async () => {
    mockCreate.mockResolvedValueOnce(
      toolResponse([meal({ cook_time_minutes: 3 })])
    );
    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('silently retries when first attempt has no tool_use block, then succeeds', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'sorry no tool here' }],
      })
      .mockResolvedValueOnce(toolResponse([meal()]));
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws JsonParseError after two attempts with no tool_use block', async () => {
    const noTool = { content: [{ type: 'text', text: 'nope' }] };
    mockCreate.mockResolvedValueOnce(noTool).mockResolvedValueOnce(noTool);
    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      JsonParseError
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

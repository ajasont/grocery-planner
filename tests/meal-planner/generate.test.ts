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
    cuisine: null,
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
      if (mealType === 'dinner' && !seenTypes.has('dinner')) {
        seenTypes.add('dinner');
        return { content: [{ type: 'text', text: 'no tool here' }] };
      }
      return fullChunk(mealType);
    });
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
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
          return fullChunk('dinner', (_d, i) => ({
            cuisine: i < 5 ? 'italian' : 'thai',
          }));
        }
        return fullChunk('dinner', () => ({ cuisine: 'thai' }));
      }
      return fullChunk(mealType);
    });
    const plan = await generatePlan(baseInput(), CANONICAL_IDS);
    expect(plan.meals).toHaveLength(28);
    expect(dinnerCallCount).toBe(2);
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

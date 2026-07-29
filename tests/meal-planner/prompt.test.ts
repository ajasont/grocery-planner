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

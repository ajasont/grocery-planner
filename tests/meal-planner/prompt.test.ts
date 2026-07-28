import { describe, it, expect } from 'vitest';
import { buildPrompt } from '@/lib/meal-planner/prompt';
import type { PlannerInput } from '@/lib/meal-planner/types';

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

describe('buildPrompt', () => {
  it('includes all constraints from spec §9 in the system prompt', () => {
    const { system } = buildPrompt(baseInput());
    expect(system).toMatch(/7 breakfast/i);
    expect(system).toMatch(/7 lunch/i);
    expect(system).toMatch(/7 dinner/i);
    expect(system).toMatch(/7 snack/i);
    expect(system).toMatch(/30.*60/); // weeknight time budget
    expect(system).toMatch(/no cuisine.*more than twice/i);
    expect(system).toMatch(/well-known/i);
  });

  it('lists deals in the user turn with canonical name, retailer, price', () => {
    const { userText } = buildPrompt(baseInput());
    expect(userText).toContain('Chicken Breast');
    expect(userText).toContain('harris-teeter');
    expect(userText).toContain('3.49');
    expect(userText).toContain('Baby Spinach');
    expect(userText).toContain('sprouts');
  });

  it('lists pantry items in the user turn', () => {
    const { userText } = buildPrompt(baseInput());
    expect(userText).toMatch(/pantry/i);
    expect(userText).toContain('Olive Oil');
  });

  it('lists prior meal names to avoid in the user turn', () => {
    const { userText } = buildPrompt(baseInput());
    expect(userText).toMatch(/avoid|do not repeat|last.*weeks/i);
    expect(userText).toContain('Chicken Tikka Masala');
    expect(userText).toContain('Sheet-pan Salmon');
  });

  it('renders empty pantry / empty prior meals cleanly (no crash, no "undefined")', () => {
    const input = baseInput({ pantry: [], prior_meal_names: [] });
    const { userText } = buildPrompt(input);
    expect(userText).not.toContain('undefined');
    expect(userText.length).toBeGreaterThan(0);
  });

  it('includes preferences when non-empty', () => {
    const input = baseInput({
      preferences: {
        dietary_flags: ['vegetarian'],
        disliked_ingredients: ['cilantro'],
        liked_ingredients: [],
        disliked_cuisines: [],
        liked_cuisines: ['thai'],
      },
    });
    const { userText } = buildPrompt(input);
    expect(userText).toMatch(/vegetarian/);
    expect(userText).toMatch(/cilantro/);
    expect(userText).toMatch(/thai/);
  });

  it('returns a tool with generate_meal_plan schema', () => {
    const { tool } = buildPrompt(baseInput());
    expect(tool.name).toBe('generate_meal_plan');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties).toHaveProperty('meals');
  });
});

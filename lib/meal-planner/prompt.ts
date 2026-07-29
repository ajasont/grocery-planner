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

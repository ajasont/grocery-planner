import type { PlannerInput } from './types';

export const GENERATE_TOOL = {
  name: 'generate_meal_plan',
  description:
    'Emit the full 21-meal weekly plan: 7 breakfast, 7 lunch, 7 dinner, and 7 snacks (one per day).',
  input_schema: {
    type: 'object',
    properties: {
      meals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            day: {
              type: 'string',
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
              type: 'string',
              enum: ['breakfast', 'lunch', 'dinner', 'snack'],
            },
            name: { type: 'string' },
            cuisine: { type: ['string', 'null'] },
            cook_time_minutes: { type: ['integer', 'null'] },
            servings: { type: ['integer', 'null'] },
            ingredients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  canonical_id: { type: 'string' },
                  quantity: { type: ['number', 'null'] },
                  unit: { type: ['string', 'null'] },
                },
                required: ['canonical_id'],
              },
            },
            notes: { type: ['string', 'null'] },
          },
          required: ['day', 'meal_type', 'name', 'ingredients'],
        },
      },
    },
    required: ['meals'],
  },
} as const;

const SYSTEM_PROMPT = `You are a meal planner for a household of 2 adults in Baltimore. \
Your job is to generate a full week of meals from a list of on-sale ingredients.

Constraints:
- Output exactly 28 meals: 7 breakfast + 7 lunch + 7 dinner + 7 snack. One of each meal_type per day.
- Weeknight dinners: 30–60 minutes of cook time. Weekend dinners may go longer.
- Prefer meals that use ingredients from the "available on sale" list.
- Prefer well-known named recipes (things a home cook would recognize) over invented dishes.
- No cuisine may appear more than twice in the week.
- Do not repeat any meal name from the "recent meals to avoid" list.
- Respect household preferences: honor dietary_flags, exclude disliked ingredients and cuisines, bias toward liked ones.
- Every ingredient must reference a canonical_id from the "available on sale" or pantry lists (do not invent new IDs).
- Each meal needs at least 3 ingredients.
- Return via the generate_meal_plan tool.`;

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

export function buildPrompt(input: PlannerInput): {
  system: string;
  userText: string;
  tool: typeof GENERATE_TOOL;
} {
  const userText = [
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
    'Generate the full week now via the generate_meal_plan tool.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, userText, tool: GENERATE_TOOL };
}

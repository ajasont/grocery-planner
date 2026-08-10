import { getAnthropicClient } from '@/lib/anthropic/client';

export type ClassificationResult = {
  is_ingredient: boolean;
  confidence: number;
  reason: string;
};

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are classifying grocery-store flyer items to decide whether each one is a food ingredient — something a person would use to cook a meal or eat as a component of a meal.

Ingredient (is_ingredient: true): raw or minimally-processed foods, packaged staples (pasta, canned tomatoes, cereal), dairy, meat/fish, produce, oils/vinegars, spices, baking supplies.

Not an ingredient (is_ingredient: false): flowers, non-food merchandise, cleaning/household products, bottled beverages sold as drinks (soda, sports drinks, plain water), candy and snack bars marketed as impulse buys, prepared deli items ("MADE-TO-ORDER SANDWICHES"), pharmacy items, gift cards.

When in doubt, return true — the cost of showing an occasional non-ingredient is much lower than hiding a real one.

Examples:
- "Large Rose Bunches" → { is_ingredient: false, reason: "floral" }
- "MADE-TO-ORDER SANDWICHES" → { is_ingredient: false, reason: "prepared deli item" }
- "Eternal Spring Water" → { is_ingredient: false, reason: "beverage" }
- "Non-GMO Bulk Candy" → { is_ingredient: false, reason: "candy" }
- "Boneless Chicken Breast" → { is_ingredient: true, reason: "meat" }
- "Baby Spinach" → { is_ingredient: true, reason: "produce" }
- "Whole Milk" → { is_ingredient: true, reason: "dairy" }`;

const TOOL = {
  name: 'classify_ingredients',
  description:
    'For each numbered product name, classify whether it is a food ingredient. Return a short reason phrase for each (e.g. "floral", "prepared food", "meat", "produce"). Confidence is 0.0 (guess) to 1.0 (certain).',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            is_ingredient: { type: 'boolean' },
            confidence: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['index', 'is_ingredient', 'confidence', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
} as const;

export async function classifyProductNames(
  names: string[]
): Promise<ClassificationResult[]> {
  if (names.length === 0) return [];
  const client = getAnthropicClient();

  // Default to is_ingredient=true so an omitted index never hides a real product.
  const results: ClassificationResult[] = new Array(names.length)
    .fill(null)
    .map(() => ({ is_ingredient: true, confidence: 0, reason: '' }));

  const numbered = names.map((n, i) => `${i}. ${n}`).join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [TOOL as any],
    tool_choice: { type: 'tool', name: 'classify_ingredients' },
    messages: [
      {
        role: 'user',
        content: `Classify these product names:\n${numbered}`,
      },
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUse = (response.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse) return results;
  const classifications = (toolUse.input?.classifications ?? []) as Array<{
    index: number;
    is_ingredient: boolean;
    confidence: number;
    reason: string;
  }>;

  for (const c of classifications) {
    if (c.index < 0 || c.index >= names.length) continue;
    results[c.index] = {
      is_ingredient: typeof c.is_ingredient === 'boolean' ? c.is_ingredient : true,
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      reason: typeof c.reason === 'string' ? c.reason : '',
    };
  }

  return results;
}

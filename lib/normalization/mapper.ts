import { getAnthropicClient } from '@/lib/anthropic/client';
import { getCanonicalIngredients } from './canonical';

export type Mapping = {
  canonical_id: string | null;
  confidence: number;
};

const BATCH_SIZE = 20;
const MODEL = 'claude-haiku-4-5-20251001';

const TOOL = {
  name: 'map_ingredients',
  description:
    "For each numbered product name, pick the single best matching canonical ingredient ID from the provided list. Return 'unknown' if no reasonable match exists. Confidence is 0.0 (guess) to 1.0 (certain).",
  input_schema: {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            canonical_id: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['index', 'canonical_id', 'confidence'],
        },
      },
    },
    required: ['mappings'],
  },
} as const;

export async function mapProductNames(names: string[]): Promise<Mapping[]> {
  if (names.length === 0) return [];
  const canonical = await getCanonicalIngredients();
  const client = getAnthropicClient();
  const validIds = new Set(canonical.map((c) => c.id));

  const results: Mapping[] = new Array(names.length).fill(null).map(() => ({
    canonical_id: null,
    confidence: 0,
  }));

  const canonicalListText = canonical
    .map((c) => `${c.id} — ${c.name}${c.category ? ` (${c.category})` : ''}`)
    .join('\n');

  for (let start = 0; start < names.length; start += BATCH_SIZE) {
    const batch = names.slice(start, start + BATCH_SIZE);
    const numbered = batch.map((n, i) => `${i}. ${n}`).join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [TOOL as any],
      tool_choice: { type: 'tool', name: 'map_ingredients' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Canonical ingredient list:\n${canonicalListText}`,
              // Cache the canonical list — it's static across every call in this run.
              cache_control: { type: 'ephemeral' },
            } as any,
            {
              type: 'text',
              text: `Map these product names:\n${numbered}`,
            },
          ],
        },
      ],
    });

    const toolUse = (response.content as any[]).find((b) => b.type === 'tool_use');
    if (!toolUse) continue;
    const mappings = (toolUse.input?.mappings ?? []) as Array<{
      index: number;
      canonical_id: string;
      confidence: number;
    }>;

    for (const m of mappings) {
      const globalIdx = start + m.index;
      if (globalIdx < 0 || globalIdx >= names.length) continue;
      const isUnknown =
        m.canonical_id === 'unknown' ||
        m.canonical_id === '' ||
        !validIds.has(m.canonical_id);
      results[globalIdx] = {
        canonical_id: isUnknown ? null : m.canonical_id,
        confidence: typeof m.confidence === 'number' ? m.confidence : 0,
      };
    }
  }

  return results;
}

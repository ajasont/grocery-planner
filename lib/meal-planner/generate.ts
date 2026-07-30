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
  const first = buildMealTypePrompt(mealType, input, extraUserInstructions);
  const rawFirst = await callHaikuWithRetry(first.system, first.userText, first.tool);
  const firstResult = validateMealTypeChunk(rawFirst, mealType, canonicalIds);
  if (firstResult.ok) return firstResult.chunk;

  // Validation failed — retry once with a targeted repair message that quotes
  // the validator's reason. The most common cause is Haiku hallucinating a
  // canonical_id that isn't in the on-sale/pantry lists.
  const repairBlock = `Your previous attempt for the ${mealType} chunk was rejected. Reason: ${firstResult.reason}

If the reason mentions "unknown canonical_id", every ingredient MUST reference a canonical_id copied verbatim from the "Available on sale" or "Pantry" lists above. Do NOT invent, guess, or infer IDs. If a recipe would need an ingredient that isn't in either list, pick a DIFFERENT recipe.

Otherwise, address the reason directly. Return exactly 7 ${mealType} meals via the generate_meal_plan tool.`;

  const combinedInstructions = extraUserInstructions
    ? `${extraUserInstructions}\n\n${repairBlock}`
    : repairBlock;
  const retry = buildMealTypePrompt(mealType, input, combinedInstructions);
  const rawRetry = await callHaikuWithRetry(retry.system, retry.userText, retry.tool);
  const retryResult = validateMealTypeChunk(rawRetry, mealType, canonicalIds);
  if (!retryResult.ok) {
    throw new ValidationError(retryResult.reason, retryResult.kind);
  }
  return retryResult.chunk;
}

function mergeChunks(chunks: GeneratedMealTypeChunk[]): GeneratedPlan {
  return { meals: chunks.flatMap((c) => c.meals) };
}

function pickRepairTarget(
  chunks: GeneratedMealTypeChunk[],
  offendingCuisine: string
): MealType {
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

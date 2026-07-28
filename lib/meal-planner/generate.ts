import { getAnthropicClient } from '@/lib/anthropic/client';
import { buildPrompt } from './prompt';
import { validate } from './validator';
import {
  AnthropicError,
  JsonParseError,
  ValidationError,
  type GeneratedPlan,
  type PlannerInput,
} from './types';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8192;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractToolInput(content: any[]): unknown | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUse = (content as any[]).find(
    (b) => b?.type === 'tool_use' && b?.name === 'generate_meal_plan'
  );
  return toolUse ? (toolUse.input ?? null) : null;
}

async function callSonnetRaw(
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
      'Sonnet returned no generate_meal_plan tool_use block'
    );
  }
  return input;
}

// Wraps callSonnetRaw with one silent retry on JsonParseError (per spec §9).
async function callSonnetWithRetry(
  system: string,
  userText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any
): Promise<unknown> {
  try {
    return await callSonnetRaw(system, userText, tool);
  } catch (err) {
    if (err instanceof JsonParseError) {
      return await callSonnetRaw(system, userText, tool);
    }
    throw err;
  }
}

export async function generatePlan(
  input: PlannerInput,
  canonicalIds: ReadonlySet<string>
): Promise<GeneratedPlan> {
  const { system, userText, tool } = buildPrompt(input);

  // First attempt (with silent retry on JsonParseError).
  const first = await callSonnetWithRetry(system, userText, tool);
  const firstResult = validate(first, canonicalIds);
  if (firstResult.ok) return firstResult.plan;

  if (firstResult.kind === 'variety') {
    // One targeted re-prompt with a "reduce cuisine X" instruction.
    // Per spec: accept the second attempt even if variety is still borderline.
    const followUp = `${userText}\n\nYour previous attempt violated the cuisine variety rule (${firstResult.reason}). Regenerate the full week and ensure no cuisine appears more than twice.`;
    const second = await callSonnetWithRetry(system, followUp, tool);
    const secondResult = validate(second, canonicalIds, { enforceVariety: false });
    if (secondResult.ok) return secondResult.plan;
    // Second attempt failed a structural check (variety is disabled on retry).
    if (secondResult.kind === 'variety') {
      throw new Error(`unreachable: variety failure with enforceVariety=false`);
    }
    throw new ValidationError(secondResult.reason, secondResult.kind);
  }

  // Sanity or schema failure — structural, no auto-retry.
  throw new ValidationError(firstResult.reason, firstResult.kind);
}

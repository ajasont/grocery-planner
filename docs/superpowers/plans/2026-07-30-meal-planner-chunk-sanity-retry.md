# Meal Planner Chunk Sanity Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a per-meal-type Haiku chunk fails `validateMealTypeChunk` (schema or sanity), retry that one chunk once with a targeted repair message that quotes the exact failure reason — instead of failing the whole regeneration. This eliminates the current user-visible `?error=sanity` regression where Haiku hallucinates a plausible-sounding `canonical_id` (observed: `whole_milk` for an oatmeal recipe).

**Architecture:** All logic lives in `generateMealType` in `lib/meal-planner/generate.ts`. On validation failure, it appends a repair block (including the validator's `reason` string and a canonical_id-whitelist reminder) to `extraUserInstructions` and re-calls Haiku once. Only if the second attempt also fails does it throw `ValidationError`. The `Promise.all` orchestrator in `generatePlan` and the existing variety-repair path stay unchanged, and since variety repair also flows through `generateMealType`, the repair chunk gets the same retry automatically. Cost: at most one extra Haiku call per failing chunk (~3–4s), so worst-case wall-clock stays under the 20s perf target.

**Tech Stack:** Next.js 14 App Router (TypeScript), Anthropic SDK (Haiku 4.5, model id `claude-haiku-4-5-20251001`), Vitest.

**Related:**
- Perf plan that introduced per-chunk parallelism: `docs/superpowers/plans/2026-07-29-meal-planner-perf-haiku-parallel.md`
- Prod failure that motivates this: `POST /api/plan/generate` returned `?error=sanity` on 2026-07-30 with `unknown canonical_id "whole_milk" in meal "Oatmeal with Apple and Almond"`.

---

## File Structure

**Modified files (source):**

- `lib/meal-planner/generate.ts` — extend `generateMealType` with a one-shot retry on `ValidationError` from `validateMealTypeChunk`. No other files change.

**Modified files (tests):**

- `tests/meal-planner/generate.test.ts` — add a new `describe('generatePlan — per-chunk sanity retry')` block with three cases.

**Unchanged:** everything else. In particular:
- `lib/meal-planner/validator.ts` (the `reason` strings it produces are the contract for the repair message content),
- `lib/meal-planner/prompt.ts` (retry re-uses `buildMealTypePrompt` with an extended `extraUserInstructions`),
- `lib/meal-planner/types.ts`, `app/api/plan/generate/route.ts`, `/plan` UI, DB schema.

**Design notes:**

- **Retry on both `sanity` and `schema` kinds.** Schema failures are rare (tool_use enforces shape), but if one slips through, a targeted retry costs the same as a sanity retry and lets us keep one code path.
- **Only one retry.** Two attempts is the same discipline `callHaikuWithRetry` uses for `JsonParseError` — bounds worst-case latency and cost.
- **Retry re-uses `buildMealTypePrompt`** with an appended `extraUserInstructions`. This means variety-repair chunks (which already pass their own `extraUserInstructions`) get the sanity retry too, with both blocks concatenated. Order: original variety-repair block first, then sanity-repair block, so the most recent instruction is closest to the tool call.
- **Repair message includes the raw `reason` string** from the validator. The validator's messages already name the offending `canonical_id`, meal name, or field — feeding that back verbatim is the most model-legible signal.

---

## Task 1: Add per-chunk sanity retry to `generateMealType`

TDD: write three failing tests (happy-retry, double-failure escalation, repair-message content), then implement the retry inside `generateMealType`.

**Files:**
- Modify: `lib/meal-planner/generate.ts`
- Modify: `tests/meal-planner/generate.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/meal-planner/generate.test.ts`. At the end of the file (after the closing `});` of the `describe('generatePlan — variety repair')` block, i.e. after line 310), append the following block. Preserve the existing imports and helpers — the new tests reuse `DAYS`, `CANONICAL_IDS`, `baseInput`, `meal`, and `fullChunk` from earlier in the file.

```typescript
describe('generatePlan — per-chunk sanity retry', () => {
  it('retries a chunk once when it fails sanity, then succeeds', async () => {
    let breakfastCallCount = 0;
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'breakfast') {
        breakfastCallCount++;
        if (breakfastCallCount === 1) {
          // First attempt: valid shape, but one meal references an
          // unknown canonical_id ("whole_milk" is not in CANONICAL_IDS).
          return fullChunk('breakfast', (_d, i) =>
            i === 0
              ? {
                  ingredients: [
                    { canonical_id: 'oats', quantity: 1, unit: 'cup' },
                    { canonical_id: 'apple', quantity: 1, unit: 'each' },
                    { canonical_id: 'whole_milk', quantity: 0.5, unit: 'cup' },
                  ],
                }
              : {}
          );
        }
        // Retry: all valid.
        return fullChunk('breakfast');
      }
      return fullChunk(mealType);
    });

    const plan = await generatePlan(baseInput(), CANONICAL_IDS);

    expect(plan.meals).toHaveLength(28);
    expect(breakfastCallCount).toBe(2);
    // 3 other meal types (1 each) + 2 breakfast calls = 5.
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('throws ValidationError when both attempts on the same chunk fail sanity', async () => {
    mockCreate.mockImplementation(async (req) => {
      const sys = (req as { system: Array<{ text: string }> }).system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'breakfast') {
        // Every attempt returns the same unknown canonical_id.
        return fullChunk('breakfast', (_d, i) =>
          i === 0
            ? {
                ingredients: [
                  { canonical_id: 'oats', quantity: 1, unit: 'cup' },
                  { canonical_id: 'apple', quantity: 1, unit: 'each' },
                  { canonical_id: 'whole_milk', quantity: 0.5, unit: 'cup' },
                ],
              }
            : {}
        );
      }
      return fullChunk(mealType);
    });

    await expect(generatePlan(baseInput(), CANONICAL_IDS)).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it('retry user prompt quotes the validator reason and reminds about the canonical_id whitelist', async () => {
    let breakfastCallCount = 0;
    let retryUserText = '';
    mockCreate.mockImplementation(async (req) => {
      const typedReq = req as {
        system: Array<{ text: string }>;
        messages: Array<{ role: string; content: string }>;
      };
      const sys = typedReq.system[0].text;
      const mealType = (['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).find(
        (t) => sys.includes(`${t} slot`) || sys.includes(`${t} chunk`)
      )!;
      if (mealType === 'breakfast') {
        breakfastCallCount++;
        if (breakfastCallCount === 1) {
          return fullChunk('breakfast', (_d, i) =>
            i === 0
              ? {
                  ingredients: [
                    { canonical_id: 'oats', quantity: 1, unit: 'cup' },
                    { canonical_id: 'apple', quantity: 1, unit: 'each' },
                    { canonical_id: 'whole_milk', quantity: 0.5, unit: 'cup' },
                  ],
                }
              : {}
          );
        }
        retryUserText = typedReq.messages[0].content;
        return fullChunk('breakfast');
      }
      return fullChunk(mealType);
    });

    await generatePlan(baseInput(), CANONICAL_IDS);

    // The retry prompt must include:
    // (a) the specific offending canonical_id from the validator reason,
    expect(retryUserText).toMatch(/whole_milk/);
    // (b) an "unknown canonical_id" marker (validator wording),
    expect(retryUserText).toMatch(/unknown canonical_id/i);
    // (c) a reminder pointing back to the on-sale / pantry lists.
    expect(retryUserText).toMatch(/on sale/i);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/generate.test.ts -t "per-chunk sanity retry"`

Expected:
- "retries a chunk once when it fails sanity, then succeeds" → **FAIL** (currently throws `ValidationError` on the first bad chunk).
- "throws ValidationError when both attempts on the same chunk fail sanity" → **PASS** (current behavior already throws — passes for the wrong reason, but that's fine; Step 4 re-runs and it should still pass).
- "retry user prompt quotes the validator reason…" → **FAIL** (no retry happens, so `retryUserText` stays empty).

- [ ] **Step 3: Implement the retry in `generateMealType`**

Open `lib/meal-planner/generate.ts`. Replace the current `generateMealType` (lines 79–96) with:

```typescript
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
```

No other changes to this file. Do not touch imports (`ValidationError` and `buildMealTypePrompt` are already imported).

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/generate.test.ts -t "per-chunk sanity retry"`

Expected: all three PASS.

- [ ] **Step 5: Run the full meal-planner test suite to confirm no regressions**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx vitest run tests/meal-planner/`

Expected: all tests pass. In particular the pre-existing `describe('generatePlan — variety repair')` block should still pass. Note: the existing test *"propagates ValidationError if repair chunk is structurally invalid"* will now make one extra dinner call (the variety-repair chunk fails, then the sanity retry inside `generateMealType` also fails — three total dinner calls). That test only asserts `.rejects.toBeInstanceOf(ValidationError)` and does not assert on `dinnerCallCount` afterward, so it must still pass. If it fails, stop and re-read the test — do not weaken the retry logic.

- [ ] **Step 6: Type-check and lint**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && npx tsc --noEmit && npm run lint`

Expected: no errors, no new warnings.

- [ ] **Step 7: Commit**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner add lib/meal-planner/generate.ts tests/meal-planner/generate.test.ts
git -C /Users/jasonlee/Documents/Coding/grocery-planner commit -m "Retry each meal-type chunk once on validation failure

Haiku 4.5 occasionally hallucinates a canonical_id not in the on-sale
or pantry lists, which fails validateMealTypeChunk and surfaces to users
as ?error=sanity. Add a one-shot retry inside generateMealType that
appends a repair block quoting the validator's reason plus a canonical_id
whitelist reminder. Repair message is concatenated onto any existing
extraUserInstructions, so variety-repair chunks get the same retry."
```

---

## Task 2: Deploy and smoke-test in prod

The fix must actually stop the `?error=sanity` failure end-to-end. Auto-deploy on push, then hit `/plan` and regenerate.

**Files:** none.

- [ ] **Step 1: Push to main**

```bash
git -C /Users/jasonlee/Documents/Coding/grocery-planner push origin main
```

Expected: push succeeds; Vercel starts building.

- [ ] **Step 2: Wait for the deploy to reach Ready**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && vercel ls --scope team_l1Y3OANBxglJyIIbGfOrS9Ch | head -5`

Expected: top row shows `● Ready`, age well under 2 minutes. (Prior deploys have been 32–54s.) If it says `● Building` or `● Queued`, wait and re-run.

- [ ] **Step 3: Regenerate the plan and time it**

Open `https://grocery-planner-omega.vercel.app/plan` in a browser (Playwright MCP or manual). Click **Regenerate**, accept the confirm dialog, and note the wall-clock until the page rerenders with a new plan.

Expected:
- Page renders a fresh plan (no `?error=…` in URL).
- Wall-clock ≤ 25s. If retries fired, expect closer to 18–22s; if not, closer to the baseline ~15s.

If the URL comes back with `?error=…`:
- `?error=sanity` → both attempts failed. Pull logs (`vercel logs https://grocery-planner-omega.vercel.app --scope team_l1Y3OANBxglJyIIbGfOrS9Ch | tail -30`) and inspect the validator reason from the *second* attempt. Consider tightening the repair message before adding a third attempt.
- `?error=anthropic` or `?error=json` → unrelated to this change; investigate separately.
- `?error=variety` → variety repair failed twice. Also unrelated to this change but worth logging.

- [ ] **Step 4: Confirm the retry actually fires (optional but recommended)**

Run: `cd /Users/jasonlee/Documents/Coding/grocery-planner && vercel logs https://grocery-planner-omega.vercel.app --scope team_l1Y3OANBxglJyIIbGfOrS9Ch | tail -30`

Look for either:
- No error logs during the regeneration → first attempt succeeded, retry did not fire (fine; the fix is dormant insurance).
- An error log from the first attempt only, followed by a successful redirect → the retry saved a user-visible failure. Note the offending `canonical_id` in the smoke-test notes; it may inform later prompt hardening or mapper data-quality work (week 2b).

- [ ] **Step 5: Update project memory with the retry behavior**

Edit `/Users/jasonlee/.claude/projects/-Users-jasonlee/memory/project_grocery_planner.md`. Update the "Haiku 4.5 hallucination gotcha" paragraph to note the new safety net. Example replacement:

> **Haiku 4.5 hallucination gotcha (mitigated in prompt.ts + generate.ts):** Haiku will invent plausible-sounding canonical_ids (e.g. `jasmine_rice`, `parmesan_cheese`, `whole_milk`) if a recipe wants an ingredient not on the sale/pantry list. Two-layer mitigation: (1) the system prompt leads with a "CRITICAL — canonical_id whitelist" block with worked examples; (2) `generateMealType` retries a failing chunk once with a repair message that quotes the validator reason and re-states the whitelist rule. If both attempts fail, `/plan` still surfaces `?error=sanity` — watch prod logs for that.

Then bump the "Status" line's date and mention the retry.

---

## Self-Review Notes

- Spec coverage: the one requirement ("retry a chunk once on sanity failure with a targeted repair message") is covered by Task 1 Steps 1–4. Escalation on double-failure covered by Task 1 Step 1 test #2. Prod verification covered by Task 2.
- No placeholders — every code block is complete, every command is exact.
- Type consistency: `generateMealType` signature and return type unchanged; `buildMealTypePrompt` and `validateMealTypeChunk` signatures unchanged; `ValidationError` constructor unchanged.
- Interaction with existing variety repair: verified in Task 1 Step 5. The existing "propagates ValidationError if repair chunk is structurally invalid" test still passes because it doesn't assert `dinnerCallCount` after the failure.

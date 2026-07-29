# Meal Planner Perf: Haiku 4.5 + Parallel by Meal Type

**Date:** 2026-07-29
**Parent spec:** `docs/superpowers/specs/2026-07-28-week-3a-meal-planner-v1-design.md`
**Motivating observation:** the week-3a implementation lands correct plans but a single `POST /api/plan/generate` was measured at ~130s wall-clock in the Task 14 smoke test — 6.5× over the ≤20s spec target and beyond the point where the UX still feels responsive.

## Goal

Bring wall-clock time for `POST /api/plan/generate` under **20 seconds** on the happy path, without regressing on plan correctness (schema, sanity, canonical-id integrity, prior-meal avoidance, cuisine variety) or plan quality (meal recognizability and household-preference respect). Keep the current DB schema, `/plan` UI, and public route surface unchanged.

## Non-goals

- **Streaming / progressive rendering.** The v1 skeleton wait is fine once wall-clock is under 20s. Streaming stays deferred.
- **Cost reduction as a primary axis.** Cost will fall out (Haiku is cheaper than Sonnet), but the design is optimized for latency, not cost.
- **Single-meal regenerate, pantry integration, prefs UI, lazy recipe steps.** All still deferred to week 3b as in the v1 spec.
- **Prompt trimming beyond what falls out naturally from splitting per meal type.** Not deleting deals from the input.

## Root-cause of the 130s

- Output-token dominated: Sonnet 4.6 emits ~7K tokens of structured tool JSON for 28 meals (≈ 250 tokens/meal). At ~55 tok/s that alone budgets ~130s.
- System-prompt caching (`cache_control: ephemeral`) is already on and helps, but it caches the ~200-token constraints prefix — not the output.
- Input side (~3K tokens including ~200 deals) is not the bottleneck.
- The variety re-prompt loop did not fire in the observed run; it would only make things worse when it does.

**Implication:** cutting per-token latency (faster model) and cutting per-call output tokens (fewer meals per call, in parallel) are the two productive levers. Doing both together is what makes ≤20s reachable.

## Approach

**Two changes, applied together:**

1. Switch the meal-planning model from `claude-sonnet-4-6` to `claude-haiku-4-5-20251001`.
2. Replace the single sequential Sonnet call with **four parallel Haiku calls, one per `meal_type`** (`breakfast`, `lunch`, `dinner`, `snack`). Each call generates exactly 7 meals — one per day — with its `meal_type` fixed by a narrowed tool schema. Cross-cut cuisine variety is validated once after the four results are merged. On variety failure, a single targeted repair call regenerates the offending meal type.

Why this combination:

- Haiku 4.5 outputs at roughly 3-5× Sonnet's rate on this task, but a single Haiku call for all 28 meals is still ~40s — misses the target.
- Parallelizing by meal type cuts the wall clock to the slowest of four calls (each ~1.5K output tokens). Estimated 10-15s happy path.
- Meal type is the natural cut: each call carries only the constraints relevant to its type (weeknight cook-time rules go only in the dinner prompt; the ≥3-ingredients rule goes only in breakfast/lunch/dinner; the snack prompt has the "1-2 ingredients" rule instead). Cross-call coordination reduces to one constraint: cuisine variety across the merged 28 meals.
- Splitting by day (7 parallel calls) would be faster still but requires pre-assigned cuisine budgets and loses cross-day meal coherence; not worth it here.

## Data flow

```
getPlannerInput()  →  generatePlan(input, canonicalIds)
                           │
                           ├─► generateMealType('breakfast', ...)  →  7 meals ─┐
                           ├─► generateMealType('lunch',     ...)  →  7 meals ─┤
                           ├─► generateMealType('dinner',    ...)  →  7 meals ─┤
                           └─► generateMealType('snack',     ...)  →  7 meals ─┤
                                                                                │
                                                          merge (28) ◄──────────┘
                                                              │
                                                validateVarietyAcrossPlan(...)
                                                              │
                                            ┌─────────────────┴─────────────────┐
                                          pass                                 fail
                                            │                                   │
                                          return                    repairVariety(plan, offendingMealType)
                                                                                │
                                                                              return
```

Persist path (`savePlan`, `getCurrentWeekPlan`, `/plan` UI, DB schema) is untouched.

## Components and files

**Modified**

- `lib/meal-planner/prompt.ts`
  - Replace `buildPrompt(input)` with `buildMealTypePrompt(mealType, input)`.
  - System prompt is trimmed per meal type: dinner keeps weeknight/weekend cook-time rules; breakfast/lunch/dinner keep "≥3 ingredients"; snack keeps its own "1-2 ingredients, 0 cook time OK" rule. The "no cuisine >2×/week" line stays in all four (as a hint), but enforcement is post-merge.
  - Narrow the `generate_meal_plan` tool schema per call: the `meal_type` property is a single-value enum, and `meals` requires exactly 7 items with `day` covering the week.
  - Keep the shared user-turn context: on-sale deals list, pantry, preferences, prior meals. All four calls receive identical context so the cached system prefix hits on 3 of 4 calls within the 5-min TTL.

- `lib/meal-planner/generate.ts`
  - `MODEL` constant → `claude-haiku-4-5-20251001`.
  - New `generateMealType(mealType, input, canonicalIds): Promise<GeneratedMealTypeChunk>` — single Haiku call + per-call structural validation + one-shot silent retry on `JsonParseError`, same retry semantics as v1.
  - `generatePlan(input, canonicalIds)` becomes:
    1. `const chunks = await Promise.all(['breakfast','lunch','dinner','snack'].map(t => generateMealType(t, ...)))`
    2. `const merged = mergeChunks(chunks)` → `GeneratedPlan` shape
    3. `const varietyResult = validateVarietyAcrossPlan(merged)`
    4. If ok, return `merged`. Otherwise, `return await repairVariety(merged, varietyResult, input, canonicalIds)`.
  - Delete the current sequential variety re-prompt loop; replaced by the parallel + targeted-repair pathway.
  - `repairVariety(plan, varietyResult, input, canonicalIds)` picks the meal type contributing the most instances of the over-represented cuisine, calls `generateMealType` for that type with an added user-turn constraint block ("Do not use cuisine X. Do not use these meal names: [names from the other three chunks]"), replaces that chunk in the merged plan, and returns. No enforcement of variety on the repair result (mirrors v1 behavior on retry). If the repair returns a structurally invalid chunk, surface as `ValidationError`.

- `lib/meal-planner/validator.ts`
  - Refactor internal: split `validate` into `validateMealTypeChunk(chunk, mealType, canonicalIds)` (schema, sanity, canonical IDs, prior-meal avoidance, day coverage — exactly one meal per day for that meal type) and `validateVarietyAcrossPlan(plan)` (returns `{ ok: true } | { ok: false, offendingCuisine: string, meals: MealRef[] }`).
  - Public surface consumed by `/api/plan/generate` stays the same (`GeneratedPlan` returned or typed error thrown).

- `lib/meal-planner/types.ts`
  - Add `GeneratedMealTypeChunk = { mealType: MealType; meals: GeneratedMeal[] }` for the intermediate shape returned by `generateMealType`.

**Unchanged**

- `lib/meal-planner/inputs.ts`, `lib/meal-planner/persist.ts`, `lib/meal-planner/read.ts`
- `lib/dates.ts`, `lib/db/client.ts`, `lib/anthropic/client.ts`
- `app/api/plan/generate/route.ts` (still calls `generatePlan(input, canonicalIds)` and gets a `GeneratedPlan`)
- `/plan` UI (`app/plan/*`)
- DB schema (`meal_plans`, `meals`, `meal_ingredients`)

## Error handling

Behavior on the seven kinds of failure that can happen during a generate:

| Failure | Where | New behavior |
|---|---|---|
| `AnthropicError` from any of the 4 parallel calls | `generateMealType` | `Promise.all` rejects, other in-flight calls abandoned by the runtime, `/api/plan/generate` returns `303 /plan?error=anthropic`. Same UX as v1. |
| `JsonParseError` from a chunk | `generateMealType` | Silent one-shot retry of that single chunk. If retry also fails, surface as `JsonParseError`. `/plan?error=json`. |
| Schema / sanity / canonical / day-coverage failure of a chunk | `validateMealTypeChunk` | `ValidationError` propagates. `/plan?error=schema` or `?error=sanity`. No partial plan is ever passed to `savePlan`. |
| Cross-cut variety failure | after merge | `repairVariety` runs once. |
| Repair call `AnthropicError` | `repairVariety` | Same as top row — `/plan?error=anthropic`. |
| Repair call structural failure | `repairVariety` | `ValidationError` — `/plan?error=schema` or `?error=sanity`. |
| Repair result still fails variety | not checked | Accepted. Matches v1's retry acceptance behavior. |

Kinds emitted through `errorKind()` in `app/api/plan/generate/route.ts` remain the same set: `anthropic`, `json`, `variety`, `schema`, `sanity`, `unknown`. The `variety` kind is now only reachable if `repairVariety` throws a `VarietyError` — which we won't throw in v2; kept in the union for future headroom.

## Prompt caching

- The system prompt for each meal type is different (trimmed constraints), so caching is per-meal-type.
- Within a single generation, breakfast/lunch/dinner/snack each get their own cache entry.
- Within a single generation, the four calls fire concurrently — no reuse of another call's cached prefix.
- Across generations (same user hitting Regenerate within 5 min), all four meal-type prefixes hit their respective caches.
- Cost impact vs v1: probably neutral to slightly better, since Haiku input cost is much lower than Sonnet.

## Testing

**Unit tests (Vitest)**

- `tests/meal-planner/prompt.test.ts`
  - `buildMealTypePrompt('dinner')` includes the weeknight/weekend cook-time rule; `buildMealTypePrompt('breakfast')` does not.
  - `buildMealTypePrompt('snack')` includes the "1-2 ingredients" rule and omits "≥3 ingredients".
  - Tool schema returned for each meal type has `meal_type` as a single-value enum and requires exactly 7 items.
  - System prompt has `cache_control: ephemeral` marker in all four.
- `tests/meal-planner/generate.test.ts`
  - Happy path: 4 mocked chunks return valid; assert 4 concurrent client calls; assert merged output has 28 meals; assert no repair call fired.
  - JSON-parse retry: one chunk returns a malformed content block, second call returns valid; assert exactly one silent retry for that chunk and no cascade to the other three.
  - Per-chunk structural failure: one chunk returns 6 meals instead of 7; assert `ValidationError` bubbles out; assert `savePlan` is not invoked.
  - Variety-repair path: 4 chunks return valid but the merged plan has cuisine × 3 in dinner; assert repair is called once with `mealType='dinner'` and a disallow-cuisine constraint in the user turn; assert final plan uses the repaired dinner chunk.
  - Repair failure: repair call returns a structurally invalid chunk; assert `ValidationError` propagates.
- `tests/meal-planner/validator.test.ts`
  - Extend to cover `validateMealTypeChunk` day-coverage (7 unique days) and `meal_type` field consistency.
  - Extend to cover `validateVarietyAcrossPlan` — pass on ≤2 per cuisine, fail with correct `offendingCuisine` on 3+.
- Existing `tests/meal-planner/inputs.test.ts` — unchanged.

**Smoke test (manual, mirrors Task 14)**

- Repeat the Task 14 checklist against local + prod after the implementation lands.
- Add wall-clock assertions: happy-path POST completes in **≤ 20s** (target), **≤ 30s** (soft ceiling for the repair path).
- Cost check on the first two runs (Anthropic dashboard): confirm per-generation cost drops from ~$0.10 to ~$0.03-0.05.

## Success criteria

1. `POST /api/plan/generate` returns in ≤ 20s on happy path (measured via server access log or a lightweight timing log line in the route).
2. All 83 existing tests continue to pass; new tests added for the four categories above.
3. `/plan` UI renders the populated view immediately after redirect (cache fix from Task 14 still holds — no regression).
4. Manual review of one generated plan: no repeated meal names, cuisine variety respected, all ingredient IDs resolve to canonicals, cook times sane.
5. Cost per generation drops to ~$0.03-0.05 as measured over the first ~5 real generations.

## Open questions / to confirm during implementation

- Prompt caching cache-key sensitivity: verify empirically that the four meal-type prefixes each cache correctly. If not, the "3 of 4 calls hit cache" reasoning collapses; still meets latency target because the per-token cost is small.
- Haiku 4.5's tool-use reliability at this schema size: if `JsonParseError` retry rate is materially higher than Sonnet's, add a second retry (currently one shot) before treating as terminal. Decide during implementation based on observed rate in the first ~5 runs.

## Rollback plan

If Haiku 4.5 quality is unacceptable (subjective judgment after ~3-5 real generations), revert to a single-model swap — Sonnet 4.6 but keep the parallel-by-meal-type structure. Estimated wall-clock ~35-50s: still a large improvement over v1's 130s, misses the ≤20s target. Escape hatch is a one-line `MODEL` constant change.

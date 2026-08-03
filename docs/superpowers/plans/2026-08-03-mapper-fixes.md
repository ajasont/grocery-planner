# Mapper Data-Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the mapper from substituting wrong-but-similar canonicals for three known cases (Mahi Mahi → cod_fillet, Turkey Sausage → turkey_breast, margarine → butter_salted) by adding the missing canonicals, tightening the mapper's prompt, and running a one-off remap script.

**Architecture:** Three coordinated changes — (1) add three rows to `lib/canonical-ingredients/seed-data.ts`, (2) add a `system` parameter with named-example guardrails to `lib/normalization/mapper.ts`, (3) add a one-off `scripts/remap-known-bad.ts` following the existing `scripts/map-unmapped.ts` pattern. No runner or schema changes.

**Tech Stack:** TypeScript, Vitest, Supabase-js, Anthropic Haiku 4.5 (`@anthropic-ai/sdk`), `tsx` for scripts.

**Spec:** `docs/superpowers/specs/2026-08-03-mapper-fixes-design.md`

---

## File Structure

- **Modify:** `lib/canonical-ingredients/seed-data.ts` — append three rows to `CANONICAL_INGREDIENTS`.
- **Modify:** `tests/canonical-ingredients/seed.test.ts` — assert the three new IDs are present.
- **Modify:** `lib/normalization/mapper.ts` — add `SYSTEM_PROMPT` const and wire it into `client.messages.create`.
- **Modify:** `tests/normalization/mapper.test.ts` — assert `system` is passed on every batch call.
- **Create:** `scripts/remap-known-bad.ts` — one-off cleanup script.

---

## Task 1: Add missing canonicals + assertion tests

**Files:**
- Modify: `lib/canonical-ingredients/seed-data.ts`
- Modify: `tests/canonical-ingredients/seed.test.ts`

- [ ] **Step 1: Add a failing test for the three new canonicals**

Append this `describe` block to `tests/canonical-ingredients/seed.test.ts` at the end of the file (after the existing `describe('canonical ingredients seed — shopping_group', ...)` block, still inside module scope):

```typescript
describe('canonical ingredients seed — mapper fix additions', () => {
  it('includes mahi_mahi as a seafood canonical', () => {
    const row = byId.get('mahi_mahi');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Mahi Mahi');
    expect(row?.category).toBe('seafood');
    expect(row?.aisle_group).toBe('seafood');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });

  it('includes turkey_sausage as a poultry canonical', () => {
    const row = byId.get('turkey_sausage');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Turkey Sausage');
    expect(row?.category).toBe('poultry');
    expect(row?.aisle_group).toBe('meat');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });

  it('includes margarine as a dairy-aisle canonical', () => {
    const row = byId.get('margarine');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Margarine');
    expect(row?.category).toBe('dairy');
    expect(row?.aisle_group).toBe('dairy');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/canonical-ingredients/seed.test.ts`

Expected: 3 new tests FAIL with messages like `expected undefined to be defined` (rows don't exist yet). The 3 existing tests still pass.

- [ ] **Step 3: Add mahi_mahi to seed-data.ts**

Modify `lib/canonical-ingredients/seed-data.ts`. Find the Seafood block (currently ends with `tilapia_fillet` around line 91). Insert a new row after `tilapia_fillet` and before the `tuna_canned` / `sardines_canned` pantry-seafood rows:

Find:
```typescript
  { id: 'tilapia_fillet', name: 'Tilapia Fillet', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood', shopping_group: null },
  { id: 'tuna_canned', name: 'Canned Tuna', category: 'seafood', default_unit: 'can', aisle_group: 'pantry', shopping_group: null },
```

Replace with:
```typescript
  { id: 'tilapia_fillet', name: 'Tilapia Fillet', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood', shopping_group: null },
  { id: 'mahi_mahi', name: 'Mahi Mahi', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood', shopping_group: null },
  { id: 'tuna_canned', name: 'Canned Tuna', category: 'seafood', default_unit: 'can', aisle_group: 'pantry', shopping_group: null },
```

- [ ] **Step 4: Add turkey_sausage to seed-data.ts**

In the same file, find the poultry block ending in `turkey_breast` (around line 84):

Find:
```typescript
  { id: 'ground_turkey', name: 'Ground Turkey', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },
  { id: 'turkey_breast', name: 'Turkey Breast', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },
```

Replace with:
```typescript
  { id: 'ground_turkey', name: 'Ground Turkey', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },
  { id: 'turkey_breast', name: 'Turkey Breast', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },
  { id: 'turkey_sausage', name: 'Turkey Sausage', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },
```

- [ ] **Step 5: Add margarine to seed-data.ts**

In the same file, find the dairy block ending in `butter_salted` (around line 101):

Find:
```typescript
  { id: 'butter_unsalted', name: 'Unsalted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
  { id: 'butter_salted', name: 'Salted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
```

Replace with:
```typescript
  { id: 'butter_unsalted', name: 'Unsalted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
  { id: 'butter_salted', name: 'Salted Butter', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
  { id: 'margarine', name: 'Margarine', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/canonical-ingredients/seed.test.ts`

Expected: All 6 tests PASS (3 existing + 3 new).

- [ ] **Step 7: Run the full test suite to confirm nothing else broke**

Run: `npm test`

Expected: All tests pass. No new failures.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`

Expected: same 9 pre-existing errors as `main` (documented in the memory), no new errors.

- [ ] **Step 9: Commit**

```bash
git add lib/canonical-ingredients/seed-data.ts tests/canonical-ingredients/seed.test.ts
git commit -m "feat(canonical): add mahi_mahi, turkey_sausage, margarine

Adds three canonicals that Haiku was previously substituting with
similar-but-wrong ingredients (Mahi Mahi → cod_fillet, Turkey Sausage
Links → turkey_breast, margarine → salted_butter). Prompt tightening
in a follow-up commit; DB seeding requires a separate manual step."
```

---

## Task 2: Add mapper system prompt

**Files:**
- Modify: `lib/normalization/mapper.ts`
- Modify: `tests/normalization/mapper.test.ts`

- [ ] **Step 1: Write a failing test that asserts `system` is passed**

Add this test to the `describe('mapProductNames', ...)` block in `tests/normalization/mapper.test.ts` (append it as the last test inside the describe):

```typescript
  it('sends a system prompt with the substitution guardrails on every batch', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [{ index: 0, canonical_id: 'chicken_breast', confidence: 0.9 }],
          },
        },
      ],
    });

    await mapProductNames(['Chicken Breast']);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0] as { system?: string };
    expect(typeof args.system).toBe('string');
    // The prompt must reference the three known-bad examples so a future
    // edit that accidentally drops the guardrails fails this test.
    expect(args.system).toMatch(/Mahi Mahi/);
    expect(args.system).toMatch(/Turkey Sausage/);
    expect(args.system).toMatch(/Margarine/);
    // And it must give the model explicit permission to return "unknown".
    expect(args.system).toMatch(/unknown/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/normalization/mapper.test.ts`

Expected: the new test FAILS with `expected undefined to be a string` (or similar — `system` is not passed today). All other mapper tests still pass.

- [ ] **Step 3: Add the SYSTEM_PROMPT constant and wire it in**

Modify `lib/normalization/mapper.ts`.

First, add the constant. Find:

```typescript
const BATCH_SIZE = 20;
const MODEL = 'claude-haiku-4-5-20251001';
```

Insert directly below:

```typescript
const SYSTEM_PROMPT = `You are matching retailer product names to canonical grocery ingredients.

Match on the product's core noun — the specific food type — not on visual, cost, or aisle similarity. Two products that live near each other in a store are not the same ingredient.

Return "unknown" when the product's core noun does not appear in the canonical list. It is always correct to return "unknown"; it is never correct to substitute a different food.

Examples of the substitution mistake to avoid:
- A "Mahi Mahi" fillet is not "Cod Fillet". Different fish are different ingredients.
- "Turkey Sausage Links" or "Turkey Sausage" is not "Turkey Breast". Sausage and breast are different cuts.
- "Margarine" is not "Salted Butter". Margarine and butter are different fats.
- A "Pork Loin Chop" is not "Pork Tenderloin". Different cuts are different ingredients.

If the product is not a cookable ingredient at all (e.g., flowers, prepared sandwiches, bulk candy, gift cards), return "unknown".`;
```

Second, wire it into the `client.messages.create` call. Find:

```typescript
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [TOOL as any],
      tool_choice: { type: 'tool', name: 'map_ingredients' },
      messages: [
```

Replace with:

```typescript
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [TOOL as any],
      tool_choice: { type: 'tool', name: 'map_ingredients' },
      messages: [
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/normalization/mapper.test.ts`

Expected: All 7 tests PASS (6 existing + 1 new).

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`

Expected: All tests pass. No new failures.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: same 9 pre-existing errors, no new ones.

- [ ] **Step 7: Commit**

```bash
git add lib/normalization/mapper.ts tests/normalization/mapper.test.ts
git commit -m "feat(mapper): add system prompt with substitution guardrails

Haiku 4.5 was substituting similar-but-wrong canonicals (Mahi Mahi →
cod_fillet, Turkey Sausage → turkey_breast, margarine → salted_butter)
when no exact canonical existed. Adds a system prompt with named
examples and explicit permission to return \"unknown\" so the model
prefers no-match over a plausible substitute."
```

---

## Task 3: Add one-off cleanup script

**Files:**
- Create: `scripts/remap-known-bad.ts`

- [ ] **Step 1: Create the cleanup script**

Create `scripts/remap-known-bad.ts` with this exact content:

```typescript
import { config } from 'dotenv';
config({ path: '.env.local' });
import { getServerClient } from '../lib/db/client';
import { runMappingForUnmappedSkus } from '../lib/normalization/runner';

// Retailer product name patterns → the canonical they are currently mis-mapped to.
// We unset the mapping on any SKU where BOTH the name matches AND the current
// canonical matches, so the next mapper pass re-maps them against the corrected
// canonical list. Rows correctly mapped are untouched.
const BAD_MAPPINGS: Array<{ namePattern: string; wrongCanonical: string }> = [
  { namePattern: '%mahi%',           wrongCanonical: 'cod_fillet' },
  { namePattern: '%turkey%sausage%', wrongCanonical: 'turkey_breast' },
  { namePattern: '%turkey%link%',    wrongCanonical: 'turkey_breast' },
  { namePattern: '%margarine%',      wrongCanonical: 'butter_salted' },
];

async function main() {
  const supabase = getServerClient();
  let totalCleared = 0;

  for (const { namePattern, wrongCanonical } of BAD_MAPPINGS) {
    const { data, error } = await supabase
      .from('retailer_skus')
      .update({ canonical_ingredient_id: null, mapping_verified: false })
      .ilike('product_name', namePattern)
      .eq('canonical_ingredient_id', wrongCanonical)
      .select('id');
    if (error) throw error;
    console.log(`  cleared ${data?.length ?? 0} rows: product_name ilike "${namePattern}" mapped to ${wrongCanonical}`);
    totalCleared += data?.length ?? 0;
  }

  console.log(`\nCleared ${totalCleared} bad mappings. Re-running mapper...\n`);

  const result = await runMappingForUnmappedSkus();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script typechecks**

Run: `npx tsc --noEmit`

Expected: same 9 pre-existing errors, no new errors introduced by the script.

- [ ] **Step 3: Commit**

```bash
git add scripts/remap-known-bad.ts
git commit -m "chore(scripts): one-off remap of known-bad canonical mappings

Clears canonical_ingredient_id + mapping_verified for retailer_skus
matching (name pattern, wrong canonical) pairs, then re-runs the
mapper. Runbook:
  npm run seed
  npx tsx scripts/remap-known-bad.ts
The DB seed pass is required first so the new canonicals (mahi_mahi,
turkey_sausage, margarine) exist for the mapper to pick."
```

---

## Task 4: Production rollout (manual, not part of code review)

**This task is executed by the human after Tasks 1-3 are merged. Do NOT execute in a subagent session — it hits the production Supabase DB and the Anthropic API.**

- [ ] **Step 1: Push to `main`**

Push the three commits (or the squashed PR) so Vercel deploys the code changes. Wait for the Vercel deploy to reach Ready state.

- [ ] **Step 2: Reseed canonicals against prod DB**

From the repo root, with `.env.local` pointing at the prod Supabase project:

```bash
npm run seed
```

Expected: Script logs indicate three new canonicals (`mahi_mahi`, `turkey_sausage`, `margarine`) upserted. Existing rows are updated in place (no data loss).

- [ ] **Step 3: Run the cleanup + remap script**

```bash
npx tsx scripts/remap-known-bad.ts
```

Expected output:

```
  cleared N rows: product_name ilike "%mahi%" mapped to cod_fillet
  cleared N rows: product_name ilike "%turkey%sausage%" mapped to turkey_breast
  cleared N rows: product_name ilike "%turkey%link%" mapped to turkey_breast
  cleared N rows: product_name ilike "%margarine%" mapped to butter_salted

Cleared T bad mappings. Re-running mapper...

{
  "mapped": M,
  "skipped": S,
  "failed": F
}
```

At least one of the four `cleared N` counts should be non-zero (unless there are genuinely zero mis-mapped rows in prod, which is unlikely given the memory notes). `failed` should be 0.

- [ ] **Step 4: Smoke-test the fix via SQL**

Run these three queries in the Supabase Dashboard SQL editor (or via `psql`):

```sql
select product_name, canonical_ingredient_id
from retailer_skus
where product_name ilike '%mahi%' and canonical_ingredient_id = 'cod_fillet';
-- Expected: 0 rows.

select product_name, canonical_ingredient_id
from retailer_skus
where (product_name ilike '%turkey%sausage%' or product_name ilike '%turkey%link%')
  and canonical_ingredient_id = 'turkey_breast';
-- Expected: 0 rows.

select product_name, canonical_ingredient_id
from retailer_skus
where product_name ilike '%margarine%' and canonical_ingredient_id = 'butter_salted';
-- Expected: 0 rows.
```

- [ ] **Step 5: Sanity-check the re-mapping picked the right canonical**

```sql
select product_name, canonical_ingredient_id
from retailer_skus
where product_name ilike '%mahi%';
-- Expected: canonical_ingredient_id is 'mahi_mahi' or NULL. Not 'cod_fillet', not any other fish.

select product_name, canonical_ingredient_id
from retailer_skus
where product_name ilike '%turkey%sausage%' or product_name ilike '%turkey%link%';
-- Expected: canonical_ingredient_id is 'turkey_sausage' or NULL.

select product_name, canonical_ingredient_id
from retailer_skus
where product_name ilike '%margarine%';
-- Expected: canonical_ingredient_id is 'margarine' or NULL.
```

If any row still lands on the old wrong canonical, the prompt guardrails aren't holding — investigate before declaring done.

- [ ] **Step 6: (Optional) Regenerate `/plan` and eyeball**

Log into the prod app, click "Generate plan" on `/plan`, then navigate to `/plan/shopping-list`. Any recipe that would call for Mahi Mahi / Turkey Sausage / Margarine should now show that ingredient in the list instead of the wrong substitute.

- [ ] **Step 7: Update memory**

Update `/Users/jasonlee/.claude/projects/-Users-jasonlee/memory/project_grocery_planner.md` — remove the "Mahi Mahi → Cod Fillet, Turkey Links → Turkey Breast, margarine → Salted Butter" examples from the "Known mapper data-quality issues" note (or mark them fixed with the deploy date). Leave the "Flipp/Sprouts flyer surfaces non-ingredients" note intact — that's a separate ingestion-side problem.

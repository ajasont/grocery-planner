# Mapper Data-Quality Fixes — Design

**Date:** 2026-08-03
**Scope:** Fast fix (afternoon-scoped). Correct three known wrong-canonical mappings by adding missing canonicals, tightening the mapper prompt, and running a one-off remap script.

## Goal

Stop the mapper from substituting a similar-but-different food when the retailer product's exact ingredient isn't in the canonical list. Three observed cases:

- "Mahi Mahi" SKUs → `cod_fillet` (no `mahi_mahi` canonical existed)
- "Turkey Sausage" / "Turkey Sausage Links" → `turkey_breast` (no `turkey_sausage` canonical existed)
- "Margarine" → `salted_butter` (no `margarine` canonical existed)

Root cause is two-fold: the canonical list is missing these items *and* the mapper (Haiku 4.5 with no system prompt) will pick a plausible substitute rather than return "unknown". Fix both.

Explicitly out of scope:
- Broader canonical-list audit (only add the three known-bad items).
- Confidence-threshold logic in the mapper.
- Ingestion-side filtering of non-ingredients (roses, bulk candy, sandwiches).
- Golden-data / regression harness for the mapper.

## Architecture

Three coordinated changes, all small:

1. **Seed data** — append three canonicals to `lib/canonical-ingredients/seed-data.ts`. The seeder upserts on `id`, so re-running the seed just inserts the new rows.
2. **Mapper prompt** — add a `system` parameter to `client.messages.create` in `lib/normalization/mapper.ts` with named-example guardrails. No new code paths.
3. **Cleanup script** — `scripts/remap-known-bad.ts`, a one-off Node script (same pattern as `scripts/map-unmapped.ts`) that clears the specific wrong mappings and re-runs `runMappingForUnmappedSkus()` so the newly-unmapped SKUs get re-mapped through the corrected mapper.

Nothing changes about the runner, the tool schema, or ingestion. The mapper's public contract stays the same.

## Component 1: Canonical additions

Three new rows appended to `CANONICAL_INGREDIENTS` in `lib/canonical-ingredients/seed-data.ts`:

```typescript
// Seafood
{ id: 'mahi_mahi', name: 'Mahi Mahi', category: 'seafood', default_unit: 'lb', aisle_group: 'seafood', shopping_group: null },

// Meat & poultry
{ id: 'turkey_sausage', name: 'Turkey Sausage', category: 'poultry', default_unit: 'lb', aisle_group: 'meat', shopping_group: null },

// Dairy & eggs
{ id: 'margarine', name: 'Margarine', category: 'dairy', default_unit: 'lb', aisle_group: 'dairy', shopping_group: null },
```

Placement matches existing groupings: mahi under seafood (next to cod/tilapia), turkey_sausage under poultry (next to `turkey_breast`), margarine under dairy (next to `butter_salted`). Categories and units match neighbors so the meal planner and shopping list treat them like closely-related canonicals.

Note: `margarine` uses `category: 'dairy'` even though margarine is technically non-dairy. The `category` field drives display grouping, not food-science accuracy, and 'dairy' matches where a shopper actually finds it.

## Component 2: Mapper system prompt

Add a top-level `SYSTEM_PROMPT` const in `lib/normalization/mapper.ts`:

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

Wire into the existing `client.messages.create` call:

```typescript
const response = await client.messages.create({
  model: MODEL,
  max_tokens: 2048,
  system: SYSTEM_PROMPT,
  tools: [TOOL as any],
  tool_choice: { type: 'tool', name: 'map_ingredients' },
  messages: [ /* unchanged */ ],
});
```

Design notes:
- Named examples first, general rule second. Haiku responds better to concrete "don't do X" cases than abstract principles. The three known bugs anchor the rule; the pork example generalizes it so Haiku doesn't overfit to just those three.
- Explicit permission to return "unknown" — the tool description mentions it, but a system-level "unknown is always safe" line makes the model more willing to actually pick it.
- The pork loin / pork tenderloin example is generalization, not a known bug — it's there to prevent the rule from collapsing to only the named-fix cases.

## Component 3: Cleanup script

New file: `scripts/remap-known-bad.ts`.

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
      .from('raw_products')
      .update({ canonical_ingredient_id: null, mapping_verified: false })
      .ilike('name', namePattern)
      .eq('canonical_ingredient_id', wrongCanonical)
      .select('id');
    if (error) throw error;
    console.log(`  cleared ${data?.length ?? 0} rows: name ilike "${namePattern}" mapped to ${wrongCanonical}`);
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

Runbook:

```bash
npm run seed                            # picks up the three new canonicals
npx tsx scripts/remap-known-bad.ts      # clears bad rows + re-runs mapper
```

Design notes:
- Narrow updates: the `ilike` + `eq(canonical_ingredient_id, wrongCanonical)` combo means we only touch rows matching both the name pattern *and* the specific wrong canonical. Rows correctly mapped to `cod_fillet` (real cod) or `turkey_breast` (real breast cuts) are untouched.
- `mapping_verified = false` matches the runner's WHERE clause (`canonical_ingredient_id IS NULL AND mapping_verified = false`) so cleared rows actually get picked up.
- No dry-run flag — the filters are narrow enough to be safe, and the operation is idempotent (a second run does nothing).
- Keep or delete post-run: caller's judgment. Git history preserves it either way.

## Testing plan

Deliberately light — most of the change is data/prompt, not logic.

**Unit tests (added):**
- `tests/canonical-ingredients/seed-data.test.ts` — assert the three new IDs (`mahi_mahi`, `turkey_sausage`, `margarine`) are present in `CANONICAL_INGREDIENTS`. Guards against accidental deletion or ID rename in future edits.
- No new tests for `mapper.ts`. The existing `tests/normalization/mapper.test.ts` is structural (mocked Anthropic client); adding a `system` param doesn't change the shape it tests. Prompt behavior can only be verified by hitting the real API — that's what the smoke test below does.

**Manual smoke test (after script runs against prod DB):**
1. Query Supabase directly for a few `raw_products` rows expected to have been fixed:
   - `select name, canonical_ingredient_id from raw_products where name ilike '%mahi%';` → should now show `mahi_mahi` or `NULL`, never `cod_fillet`.
   - Same for turkey sausage → `turkey_sausage` or `NULL`.
   - Same for margarine → `margarine` or `NULL`.
2. Spot-check the script's run output — per-pattern cleared count and final mapper summary. If cleared counts are 0 for all three patterns, investigate (either no bad data exists, or the patterns don't match).
3. Optional: regenerate a meal plan at `/plan` and verify the shopping list reads cleanly (no "Cod Fillet" for a fish taco recipe that meant Mahi Mahi).

**Deliberately NOT testing:**
- Prompt regression on the other ~1000 existing mappings. Out of scope for a fast fix. Risk mitigation: the prompt is additive (adds guardrails, no changed behavior on cases already mapping correctly), and the mapper is content-cached so incremental re-runs are cheap if a regression surfaces.
- Golden-data harness for the mapper. Would be valuable long-term; separate project.

## Success criteria

- `mahi_mahi`, `turkey_sausage`, `margarine` exist in `canonical_ingredients` in prod DB.
- After running `scripts/remap-known-bad.ts` in prod, no `raw_products` rows exist where `name ilike '%mahi%'` and `canonical_ingredient_id = 'cod_fillet'`. Same for the other two patterns.
- Newly-mapped SKUs land on the correct canonical (`mahi_mahi`, `turkey_sausage`, `margarine`) or `NULL` (never on the old wrong canonical).
- Existing unit tests + typecheck still pass.

## Rollback

- Prompt regression: revert `lib/normalization/mapper.ts` change and re-deploy. The three new canonicals can stay in the DB regardless.
- Bad mapping resurfaces: re-run `scripts/remap-known-bad.ts` after fixing whatever caused the regression. Idempotent.

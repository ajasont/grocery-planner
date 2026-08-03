# Week 2b — Pasta Family Grouping (Shopping-list Rollup)

**Date:** 2026-08-03
**Status:** Design — pending user review

## Problem

The canonical ingredient list has 10 distinct pasta shapes (`pasta_spaghetti`, `pasta_penne`, `pasta_rigatoni`, `pasta_farfalle`, `pasta_orzo`, `pasta_linguine`, `lasagna_noodle`, `noodle_ramen`, `noodle_udon`, `noodle_rice`). The Haiku mapper picks the correct shape per retailer SKU, and the meal planner correctly picks specific shapes per recipe (e.g., Rigatoni Bolognese, Fettuccine Alfredo). But `buildShoppingListFromRows` aggregates by `canonical_ingredient_id`, so a week with two pasta-based meals produces two separate shopping-list rows even though the user is going to buy one box of pasta.

## Goal

Roll up pasta shapes into a single "Pasta" line on the shopping list, while preserving shape-specific naming in recipes (variety is part of the appeal). Recommend the cheapest concrete shape as the buy target; keep per-recipe usage visible so the user can decide to buy multiple boxes if they want.

## Non-Goals

- Grouping for butter, ground beef fat-content, bell peppers by color, etc. Same mechanism will work when we want them, but out of scope here.
- Wrong-mapping fixes (Mahi → Cod, margarine → Salted Butter). Separate cleanup, likely a canonical-list expansion + mapper prompt tightening.
- Flipp non-ingredient filter (roses, MADE-TO-ORDER SANDWICHES). Separate ingestion-side task.
- Meal-planner prompt changes. The planner is unchanged and continues to select specific shape canonicals.

## Design

### Data model

Add a new nullable column to `canonical_ingredients`:

```sql
-- 0004_shopping_group.sql
alter table canonical_ingredients add column shopping_group text null;
```

- No index needed — the shopping-list aggregator reads all ingredient rows per plan.
- Nullable: when NULL, aggregation falls back to grouping by `canonical_id` (i.e., today's behavior).
- Seed update: all `pasta_*` canonicals get `shopping_group: 'pasta'`. `noodle_ramen`, `noodle_udon`, `noodle_rice`, and `lasagna_noodle` stay ungrouped — they're not substitutable for Italian pasta.

Type update in `lib/db/types.ts`:

```typescript
export type CanonicalIngredient = {
  id: string;
  name: string;
  category: string | null;
  default_unit: string | null;
  aisle_group: string | null;
  shopping_group: string | null; // NEW
};
```

### Aggregation

`buildShoppingListFromRows` in `lib/meal-planner/shopping-list.ts` changes as follows:

- **Input additions:** `ingredients[i].shoppingGroup: string | null`, `deals[j].shoppingGroup: string | null`.
- **New group key:** `groupKey = shoppingGroup ?? canonicalId`.
- **Per-group aggregation:**
  - Sum `quantity` across all member canonicals used in the plan.
  - Collect `usage: Array<{mealName, canonicalId, canonicalDisplayName}>` for the sub-line ("used in: Monday's Bolognese (Rigatoni), Wednesday's Vodka (Penne)").
  - Track `memberCanonicalIdsInUse: string[]` for the server action.
- **Cheapest deal selection:** union all deals across every member canonical in the group, then apply today's picking rule (prefer any sale price, break ties by lowest price; fall back to lowest `regular_price` when no member has a sale). The winning deal's canonical becomes `cheapestMember*`. Rationale: the user is going to buy one pasta anyway; buy the cheapest available shape.
- **Retailer section:** the row lands under the retailer offering the cheapest member (same rule as today, just at the group level).
- **Display name:** small in-code map keyed by `shopping_group` value. Initial map: `{ pasta: 'Pasta' }`. Falls back to the canonical's own `name` when `shopping_group` is null (identical to today).

### `ShoppingListItem` type

```typescript
export type ShoppingListItemUsage = {
  mealDay: string;
  mealName: string;
  canonicalId: string;
  canonicalDisplayName: string;
};

export type ShoppingListItem = {
  groupKey: string;                    // NEW — replaces canonicalId as the render key
  displayName: string;                 // family display name or canonical name
  memberCanonicalIdsInUse: string[];   // NEW — used by server action
  usage: ShoppingListItemUsage[];      // NEW — powers the "used in" sub-line
  quantity: number;
  unit: string | null;
  salePrice: number | null;
  regularPrice: number | null;
  cheapestMemberCanonicalId: string;   // NEW — for the "cheapest: X" recommendation
  cheapestMemberDisplayName: string;   // NEW
  isChecked: boolean;
};
```

`isChecked` semantics: a group is checked iff *every* member in `memberCanonicalIdsInUse` has a `shopping_list_checks` row.

### Server action

`app/plan/shopping-list/actions.ts` — `toggleShoppingItem` gains a `memberCanonicalIds: string[]` parameter (replaces the single `canonicalId`):

- **On check:** upsert one `shopping_list_checks` row per member canonical, and upsert each member into `pantry` (idempotent thanks to existing UNIQUE). For an ungrouped canonical, `memberCanonicalIds = [canonicalId]` — behavior is byte-identical to today.
- **On uncheck:** delete the N check rows in one query (`.in('canonical_ingredient_id', memberCanonicalIds)`). Do NOT remove from pantry (matches existing "unchecks are usually corrections" comment).

The `useTransition` optimistic-update pattern and rapid-toggle guard in `ShoppingItemCheckbox.tsx` stay the same — just passing `memberCanonicalIds` through.

### UI

`app/plan/shopping-list/page.tsx`:

- Each row renders the family display name as the primary label.
- Below the primary label, a smaller line: `cheapest: {cheapestMemberDisplayName} @ {retailer} ${price}`.
- Below that, a compact "used in: {meal1} ({shape1}), {meal2} ({shape2})" line. Only render when `usage.length > 0` and `groupKey !== usage[0].canonicalId` (i.e., only for actual groups, to avoid noise on ungrouped rows).
- No structural HTML change beyond these additions.

### Data flow (unchanged shape, changed key)

1. Meal plan generated — meals have specific canonical IDs (e.g., `pasta_penne`, `pasta_rigatoni`) as today.
2. `buildShoppingList` in the same file queries `meal_ingredients` joined with `canonical_ingredients` — same query, now returns `shopping_group` too.
3. Deals query joined with `retailer_skus` → `canonical_ingredients` also picks up `shopping_group`.
4. `buildShoppingListFromRows` groups by `shoppingGroup ?? canonicalId`, produces the enriched items.
5. Page renders; checkbox interactions call `toggleShoppingItem(planId, memberCanonicalIds, nextChecked)`.

### Error handling

Same as today. New failure modes:
- If the DB returns a row where `shopping_group` is a string but no display-name is in the code map: display falls back to the canonical's own name. Not a crash.
- If the meal plan predates seed update (member canonicals lack `shopping_group`): those rows aggregate one-per-canonical, exactly like today. No regression.

## Testing

New tests in `tests/meal-planner/shopping-list.test.ts`:

1. Two meals with `pasta_penne` + `pasta_rigatoni` → one "Pasta" row; quantities summed; cheapest of the two shapes selected as the recommendation.
2. Mixed group members from different retailers → row lands under retailer offering the cheapest member.
3. All members ungrouped (`shopping_group=null`) → one row per canonical, same quantity/pricing/retailer as today (regression guard covering the majority of the seed list).
4. Group where only one member is in the plan → row displays family name; usage list has one entry.
5. Group with no on-sale members → lands in "Not on sale" section using any member's `regular_price`.
6. `usage` list correctly names the meal and shape for each occurrence.

New tests in `tests/actions/toggle-shopping-item.test.ts` (extend if exists, else create):

1. Check-on a group with two members inserts two `shopping_list_checks` rows and two `pantry` rows.
2. Check-off a group deletes both check rows, leaves pantry alone.
3. Ungrouped canonical (memberCanonicalIds length 1) behaves identically to prior behavior.

Seed sanity test in `tests/canonical-ingredients/seed.test.ts` (create):

1. Every one of `pasta_spaghetti`, `pasta_penne`, `pasta_rigatoni`, `pasta_farfalle`, `pasta_orzo`, `pasta_linguine` has `shopping_group === 'pasta'`. (Explicit enumeration, not prefix match — `pasta_sauce_jar` is not a pasta shape and must stay ungrouped.)
2. `noodle_ramen`, `noodle_udon`, `noodle_rice`, `lasagna_noodle`, `pasta_sauce_jar` have `shopping_group === null`.

## Rollout & rollback

- **Migration 0004** applied via Supabase Dashboard SQL Editor (same pattern as 0002, 0003).
- **Seed re-run** after code deploys: `npm run seed` upserts new `shopping_group` values onto existing rows.
- **Rollback:** additive migration → safe to revert code without touching the schema. Extreme case: `ALTER TABLE canonical_ingredients DROP COLUMN shopping_group;` restores prior state (aggregator falls back to per-canonical grouping if the code is also reverted; if only the schema is dropped but code stays, the seed loader will fail on unknown column — coordinate the revert).

## Open questions

None as of writing. If future clusters (butter, ground beef fat-content) emerge as pain points, they'll be one-row seed edits + one line in the display-name map.

# Shopping List Export — Design

**Date:** 2026-07-30
**Status:** Design approved, ready for implementation plan
**Related:** builds on `2026-07-28-week-3a-meal-planner-v1-design.md` (meal-planner v1)

## Goal

Add an interactive shopping list at `/plan/shopping-list` that turns the current week's meal plan into a check-off-as-you-shop list, grouped by retailer and priced against the current deals table. Check state persists to the database and syncs across devices (so the same list works on desktop while planning and on phone in the store).

## Non-goals (v1)

- Filters (by retailer, by category)
- Share / print / text-export view
- Quantity edits or "mark all"
- Cross-week check history
- Deal-price change alerts when reopening the list
- Any UI for the shopping list beyond the checklist itself

## User flow

1. From `/plan`, user clicks a "Shopping list" link next to the Regenerate button.
2. `/plan/shopping-list` renders a checklist grouped by retailer, with per-retailer subtotals and a grand total.
3. User checks items as they shop. Each check persists immediately (Server Action + optimistic UI). Checked items strike through.
4. On another device (or after a refresh), the same list shows the same check state.
5. When the user Regenerates the plan back on `/plan`, all prior checks are wiped via cascade — the new plan starts with a clean list.

## Product decisions (locked)

| Decision | Choice |
|---|---|
| Use mode | Interactive checklist with persistent check state |
| Dedupe strategy | One line per `canonical_id`, always summed to a single quantity; unit dropped when occurrences use mixed units |
| Pantry handling | Exclude pantry items entirely |
| Grouping | By retailer (`cheapest_retailer`), with a "Not on sale" bucket for items with no active deal |
| Cost display | Per-item price + retailer subtotal + grand total (both on-sale total and full total) |
| Check-state storage | Dedicated `shopping_list_checks` table keyed by `(meal_plan_id, canonical_id)` |
| Placement | Separate `/plan/shopping-list` route |
| Snacks | Included in the shopping list like any other meal |
| Regenerate behavior | All checks reset (cascade on new `meal_plans` row) |
| Mutation mechanism | Server Component + Server Action (no API route, no client fetcher) |
| Aggregation timing | Computed at read-time in the server component (not snapshotted onto the plan) |

## Architecture

Server-rendered page. One Server Component fetches everything, one Server Action toggles a single check, one leaf Client Component wraps the checkbox for optimistic UI. No API routes. No client-side data fetching.

### File layout

```
app/plan/shopping-list/
  page.tsx                   # Server Component: fetches + renders
  ShoppingItemCheckbox.tsx   # Client Component: leaf checkbox
  actions.ts                 # Server Action: toggleShoppingItem
lib/meal-planner/
  shopping-list.ts           # buildShoppingList() + ShoppingList types
tests/meal-planner/
  shopping-list.test.ts      # unit tests for buildShoppingList
supabase/migrations/
  0002_shopping_list.sql          # drop unused tables, add shopping_list_checks, add pantry_canonical_ingredient_ids column
```

## Data model

### Drop unused Week 1 tables

`shopping_lists` and `shopping_list_items` were defined in `0001_initial_schema.sql` as forward-looking design placeholders (per the Week 1 design), but no code ever populated them. They're superseded by the design here. Drop them in the same migration:

```sql
drop table if exists shopping_list_items;
drop table if exists shopping_lists;
```

### New table: `shopping_list_checks`

```sql
create table shopping_list_checks (
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  checked_at timestamptz not null default now(),
  primary key (meal_plan_id, canonical_ingredient_id)
);
```

- A row exists iff the item is currently checked. Toggle-off deletes the row. No `is_checked` boolean.
- `on delete cascade` on `meal_plan_id` — Regenerate replaces the `meal_plans` row and the cascade wipes prior checks. No manual cleanup path.
- `checked_at` is cheap telemetry for future features (e.g., "when did you last shop"); not surfaced in the v1 UI.
- `meal_plans.id` is `serial` (int), matching the existing schema.
- Column named `canonical_ingredient_id` to match the convention used throughout the schema (`meal_ingredients.canonical_ingredient_id`, `pantry.canonical_ingredient_id`, etc.). The application layer's `canonical_id` shorthand still resolves to this column.

### Schema change: `meal_plans.pantry_canonical_ingredient_ids TEXT[]`

The pantry list currently lives only in `PlannerInput` (server-side, not persisted alongside the plan). The shopping list needs to know which items to exclude, and the correct source of truth is the pantry Haiku saw at generation time — not the user's current pantry, which may have drifted.

Add a `pantry_canonical_ingredient_ids TEXT[] NOT NULL DEFAULT '{}'` column to `meal_plans`, written during `POST /api/plan/generate` with the snapshot of `PlannerInput.pantry` used for that generation.

## Aggregation: `buildShoppingList`

Single server-side function in `lib/meal-planner/shopping-list.ts`, called from `page.tsx`.

### Signature

```ts
export async function buildShoppingList(planId: number): Promise<ShoppingList>;

export type ShoppingList = {
  planId: number;
  weekOf: string;
  grandTotalOnSale: number;
  grandTotalAll: number;
  sections: Array<{
    retailer: string;              // e.g. "Harris Teeter" | "Not on sale"
    subtotal: number;              // sum of ceil(qty) * salePrice for on-sale sections; 0 for "Not on sale"
    items: Array<{
      canonicalId: string;
      name: string;
      quantity: number;
      unit: string | null;         // null when occurrences used mixed units
      salePrice: number | null;    // null if not on sale
      regularPrice: number | null; // null if no deal row at all
      isChecked: boolean;
    }>;
  }>;
};
```

### Steps

1. **Fetch plan** — `meal_plans` row (id, week_of, pantry_canonical_ingredient_ids).
2. **Fetch ingredients** — all `meal_ingredients` joined to `meals` for this plan (includes breakfast/lunch/dinner + snacks — same source as `RenderablePlan`).
3. **Fetch deals** — one `deals` query for the current `week_of`, joined through `retailer_skus` to `retailers` and `canonical_ingredients`. Selects `sale_price`, `regular_price`, `retailer_skus.canonical_ingredient_id`, `retailers.name`. **Important:** unlike `getCurrentWeekOnSaleDeals` in `lib/deals/read.ts` (which filters `sale_price IS NOT NULL`), this query includes rows without a sale price too — we need them to compute `grandTotalAll` for non-sale items.
4. **Fetch checks** — `shopping_list_checks` for this `planId` → `Set<canonicalIngredientId>`.
5. **Pick cheapest deal per canonical** — the deals table has no `cheapest_retailer` column; it's derived. Group deal rows by `canonical_ingredient_id`, then for each group pick the row with the lowest `sale_price` (or lowest `regular_price` if no rows have a sale price). The retailer name of the picked row is the "cheapest retailer" for that canonical. If a canonical has no deal rows at all (unmapped), it has no retailer and no price.
6. **Aggregate** per `canonical_ingredient_id`:
   - Skip if in `pantry_canonical_ingredient_ids`.
   - Sum `quantity`. If every occurrence uses the same `unit`, keep it; otherwise set `unit = null`.
   - Attach `salePrice`, `regularPrice`, and `retailer` from the picked deal row (all null if unmapped).
   - Look up `isChecked`.
7. **Group** by picked retailer (or `"Not on sale"` if the picked deal has no `sale_price`, or if the canonical has no deal rows at all — both cases share this bucket).
8. **Per-section subtotal:** `sum(ceil(quantity) * salePrice)` for on-sale sections. `0` for "Not on sale."
   - `ceil(quantity)` because per-unit sale prices don't apply to fractions (you can't buy half a chicken breast on sale). Overestimates rather than underestimates. Acceptable for v1.
9. **Sort sections** by descending subtotal (biggest deals first). "Not on sale" always last regardless of subtotal.
10. **Sort items** within a section alphabetically by name.
11. **Totals:**
    - `grandTotalOnSale` = sum of on-sale subtotals across retailer sections (excluding "Not on sale").
    - `grandTotalAll` = `grandTotalOnSale` + `sum(ceil(quantity) * regularPrice)` for items in the "Not on sale" section that still have a mapped deal row (and therefore a `regularPrice`). The `deals` table has both `sale_price` and `regular_price` columns.
    - Items with no deal row at all (unmapped canonicals) have no price info — they contribute to neither total, and their line renders with a `—` where the price would go.
    - Display: "Estimated: $X on sale / $Y total" — both numbers are useful (on-sale is what you'll pay for the discounts you're capturing; total is a rough weekly grocery estimate).

## Toggle: Server Action + Client checkbox

### `actions.ts`

```ts
'use server';

import { getServerClient } from '@/lib/db/client';
import { revalidatePath } from 'next/cache';

export async function toggleShoppingItem(
  planId: number,
  canonicalId: string,
  nextChecked: boolean
): Promise<void> {
  const supabase = getServerClient();
  if (nextChecked) {
    await supabase
      .from('shopping_list_checks')
      .upsert({ meal_plan_id: planId, canonical_ingredient_id: canonicalId });
  } else {
    await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .eq('canonical_ingredient_id', canonicalId);
  }
  revalidatePath('/plan/shopping-list');
}
```

- `meal_plans.id` is `serial` (int), so `planId` is typed `number`. All read paths use the same convention (see `lib/meal-planner/read.ts:33`).
- The application layer refers to ingredient IDs as `canonical_id` (camelCase-adjacent alias); the DB column is `canonical_ingredient_id`. This spec keeps the two straight: TS variables/props use `canonicalId`; Supabase query objects use `canonical_ingredient_id`.

### `ShoppingItemCheckbox.tsx`

```tsx
'use client';

export function ShoppingItemCheckbox({
  planId, canonicalId, initialChecked, children
}: {
  planId: number;
  canonicalId: string;
  initialChecked: boolean;
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [pending, startTransition] = useTransition();

  return (
    <label className={checked ? 'line-through opacity-60' : ''}>
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setChecked(next);                              // optimistic
          startTransition(async () => {
            try {
              await toggleShoppingItem(planId, canonicalId, next);
            } catch {
              setChecked(!next);                         // rollback on failure
            }
          });
        }}
      />
      {children}
    </label>
  );
}
```

- Optimistic update flips the checkbox instantly; rollback on Server Action failure.
- `useTransition` guards against rapid double-click races.
- `revalidatePath` re-runs `buildShoppingList` server-side so the totals stay in sync after each toggle. Cost: ~50–100ms per toggle for a ~30–50-item list. Acceptable; if it ever hurts, switch to `revalidateTag` on totals.

## Regenerate integration

No changes needed to `POST /api/plan/generate` itself, **provided** the current handler deletes the previous `meal_plans` row for the same `week_of` before inserting the new one. The `on delete cascade` on `shopping_list_checks` then wipes old checks automatically.

**Verify during implementation:** open `app/api/plan/generate/route.ts` and confirm the delete-then-insert pattern. If the handler keeps the old row and switches active-ness by some other mechanism, add a small tweak to fully delete on regenerate. (This is not a design change — it's a correctness check on the existing code before relying on the cascade.)

Also: `page.tsx` (the meal-plan page) gains a `<Link href="/plan/shopping-list">Shopping list</Link>` next to the existing `RegenerateButton`. Styled as a secondary button. No new props or state on the meal-plan page.

## Auth

The Server Action inherits the shared-password session cookie the same way `POST /api/plan/generate` does. No new auth code.

## Testing

**Unit tests for `buildShoppingList`** — the real testing focus. Fixture-driven, covering:

- Pantry canonical_ids are excluded from output.
- Same canonical across meals with matching units → summed with the unit preserved.
- Same canonical across meals with mixed units → summed with `unit: null`.
- Snacks contribute to the list.
- Items with a deal land in the retailer bucket; items with no deal land in "Not on sale."
- Retailer sections ordered by descending on-sale subtotal; "Not on sale" always last.
- Items within a section alphabetically sorted by name.
- Per-item `ceil(qty) * salePrice` math is correct (including qty=0.5 rounding up to 1).
- Checked canonical_ids surface as `isChecked: true`; unchecked as `false`.
- Empty plan (no meals) returns an empty `sections` array and zero totals without crashing.

**No unit tests** for the Server Action or the client checkbox in v1 — both are tiny, framework-heavy to test, and easier to verify by smoke test. Matches existing pattern where the `/plan` UI has no unit tests but the validator/generator have deep ones.

**Post-deploy smoke test:**
1. Navigate to `/plan/shopping-list` — verify sections, subtotals, grand total render.
2. Check 2–3 items — verify strike-through + persistence via page refresh.
3. Regenerate plan on `/plan` — verify shopping list now shows the new items and all checks are cleared.

## Cost, perf, ops

- Read cost: one plan fetch + one meals fetch + one meal_ingredients fetch + one deals batch + one checks fetch. Same order of magnitude as the existing `/plan` page.
- Write cost: one row upsert or delete per checkbox toggle. Cheap.
- Cache: existing `cache: 'no-store'` gotcha in `lib/db/client.ts` already covers Server Component fetches — no change needed.
- No new env vars, no new external dependencies.

## Rollout

Single feature branch → merge to `main` → Vercel auto-deploys. Smoke test in prod. Update `project_grocery_planner.md` memory with the new route and schema additions on completion.

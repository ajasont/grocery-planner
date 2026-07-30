# Shopping List Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an interactive shopping list at `/plan/shopping-list` that turns the current week's meal plan into a check-off-as-you-shop list grouped by retailer, with per-item sale prices, subtotals, and grand totals, and with check state persisted per `(meal_plan_id, canonical_ingredient_id)`.

**Architecture:** Server-rendered page. One Server Component fetches everything; a pure aggregation function converts rows into the render shape. A Server Action toggles a single check; a leaf Client Component wraps the checkbox for optimistic UI. No API routes. Deals-and-pantry-agnostic fixtures drive all unit tests.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres), Vitest, Tailwind, Vercel.

**Spec:** `docs/superpowers/specs/2026-07-30-shopping-list-design.md`

---

## Preflight

- [ ] **Step 1: Create a feature branch off main**

```bash
git checkout main
git pull
git checkout -b shopping-list
```

- [ ] **Step 2: Confirm you can run tests and typecheck locally**

```bash
cd ~/Documents/Coding/grocery-planner
npm test -- --run tests/meal-planner/inputs.test.ts
npx tsc --noEmit
```

Expected: `inputs.test.ts` passes (4 tests). `tsc` may report 9 pre-existing errors under `tests/ingestion/harris-teeter/*` and `tests/normalization/runner.test.ts` — those are **not** ours; ignore them. If any error mentions files under `app/plan/`, `lib/meal-planner/`, or `tests/meal-planner/`, stop and investigate.

---

## Task 1: Migration — drop unused tables, add checks table, add pantry snapshot column

**Files:**
- Create: `supabase/migrations/0002_shopping_list.sql`

- [ ] **Step 1: Create the migration file**

Create `supabase/migrations/0002_shopping_list.sql`:

```sql
-- 0002_shopping_list.sql
-- Drop Week 1 placeholder tables that were never populated by any code.
-- They are superseded by shopping_list_checks (below).
drop table if exists shopping_list_items;
drop table if exists shopping_lists;

-- Persistent check-state for /plan/shopping-list.
-- A row exists iff the item is currently checked. Toggle-off deletes the row.
-- Cascade wipes prior checks when the plan is regenerated.
create table shopping_list_checks (
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  checked_at timestamptz not null default now(),
  primary key (meal_plan_id, canonical_ingredient_id)
);

-- Snapshot the pantry canonical_ingredient_ids at plan-generation time so the
-- shopping list can exclude items using the same pantry Haiku actually saw.
alter table meal_plans
  add column pantry_canonical_ingredient_ids text[] not null default '{}';
```

- [ ] **Step 2: Apply the migration in Supabase**

Open the Supabase dashboard for the grocery-planner project → **SQL Editor** → paste the entire contents of `0002_shopping_list.sql` → **Run**.

Expected: green success message. Verify under **Table Editor**:
- `shopping_list_items` and `shopping_lists` are gone.
- `shopping_list_checks` exists with columns `meal_plan_id (int)`, `canonical_ingredient_id (text)`, `checked_at (timestamptz)`.
- `meal_plans` now has a `pantry_canonical_ingredient_ids` column of type `text[]` with default `{}`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0002_shopping_list.sql
git commit -m "Migration: shopping_list_checks + pantry snapshot on meal_plans"
```

---

## Task 2: Snapshot pantry into `meal_plans` at generation time

**Files:**
- Modify: `lib/meal-planner/persist.ts`
- Modify: `app/api/plan/generate/route.ts`

**Context:** `savePlan` currently inserts a `meal_plans` row without the pantry snapshot. `getPlannerInput` already fetches the pantry as `input.pantry: PlannerPantryItem[]`, so `route.ts` can pass the canonical IDs down.

- [ ] **Step 1: Extend `savePlan` signature and insert**

Edit `lib/meal-planner/persist.ts`. Change the signature and update the `meal_plans` insert:

```ts
export async function savePlan(
  plan: GeneratedPlan,
  weekOf: string,
  pantryCanonicalIds: string[]
): Promise<{ mealPlanId: number }> {
  const supabase = getServerClient();

  // 1. Delete any existing plan for the same week (cascades to meals + meal_ingredients + shopping_list_checks).
  const { error: delErr } = await supabase
    .from('meal_plans')
    .delete()
    .eq('week_of', weekOf);
  if (delErr) throw delErr;

  // 2. Insert the new meal_plans row with the pantry snapshot.
  const { data: mpRow, error: mpErr } = await supabase
    .from('meal_plans')
    .insert({
      week_of: weekOf,
      status: 'draft',
      pantry_canonical_ingredient_ids: pantryCanonicalIds,
    })
    .select('id')
    .single();
  if (mpErr || !mpRow) throw mpErr ?? new Error('meal_plans insert returned no row');
  const mealPlanId = mpRow.id as number;

  // ...rest of the function unchanged (meals + ingredients inserts).
```

Only the signature and the two lines inside the `.insert({...})` change. Leave steps 3-4 (meals + ingredients) exactly as they were.

- [ ] **Step 2: Update the caller in `route.ts`**

Edit `app/api/plan/generate/route.ts`. Change the `savePlan` call:

```ts
    const input = await getPlannerInput();
    const plan = await generatePlan(input, canonicalIds);
    const pantryCanonicalIds = input.pantry.map((p) => p.canonical_id);
    await savePlan(plan, getCurrentWeekOfISO(), pantryCanonicalIds);
    return redirect('/plan');
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors in `lib/meal-planner/persist.ts` or `app/api/plan/generate/route.ts`. Pre-existing errors in `tests/ingestion/*` still fine to ignore.

- [ ] **Step 4: Commit**

```bash
git add lib/meal-planner/persist.ts app/api/plan/generate/route.ts
git commit -m "Snapshot pantry canonical_ids on meal_plans at generation time"
```

---

## Task 3: Pure aggregation — `buildShoppingListFromRows` (TDD)

**Files:**
- Create: `lib/meal-planner/shopping-list.ts`
- Create: `tests/meal-planner/shopping-list.test.ts`

**Context:** Following the pattern used by `cheapestByCanonical` in `lib/meal-planner/inputs.ts` (a pure fn with unit tests + a thin async wrapper), extract the aggregation into a pure `buildShoppingListFromRows(...)` that takes fetched rows and returns the `ShoppingList` shape. Only the pure function gets tested; the async orchestrator (`buildShoppingList`) comes in Task 4 and is verified by smoke test.

- [ ] **Step 1: Create the types and function stub**

Create `lib/meal-planner/shopping-list.ts`:

```ts
export type ShoppingListInputs = {
  planId: number;
  weekOf: string;
  pantryCanonicalIds: readonly string[];
  ingredients: ReadonlyArray<{
    canonicalId: string;
    canonicalName: string;
    quantity: number | null;
    unit: string | null;
  }>;
  deals: ReadonlyArray<{
    canonicalId: string;
    retailerName: string;
    salePrice: number | null;
    regularPrice: number | null;
  }>;
  checkedCanonicalIds: ReadonlySet<string>;
};

export type ShoppingListItem = {
  canonicalId: string;
  name: string;
  quantity: number;
  unit: string | null;
  salePrice: number | null;
  regularPrice: number | null;
  isChecked: boolean;
};

export type ShoppingListSection = {
  retailer: string;
  subtotal: number;
  items: ShoppingListItem[];
};

export type ShoppingList = {
  planId: number;
  weekOf: string;
  grandTotalOnSale: number;
  grandTotalAll: number;
  sections: ShoppingListSection[];
};

const NOT_ON_SALE = 'Not on sale';

export function buildShoppingListFromRows(inputs: ShoppingListInputs): ShoppingList {
  // Filled in step-by-step through subsequent tests.
  return {
    planId: inputs.planId,
    weekOf: inputs.weekOf,
    grandTotalOnSale: 0,
    grandTotalAll: 0,
    sections: [],
  };
}
```

- [ ] **Step 2: Write the empty-plan failing test**

Create `tests/meal-planner/shopping-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildShoppingListFromRows,
  type ShoppingListInputs,
} from '@/lib/meal-planner/shopping-list';

function inputs(overrides: Partial<ShoppingListInputs> = {}): ShoppingListInputs {
  return {
    planId: 1,
    weekOf: '2026-07-27',
    pantryCanonicalIds: [],
    ingredients: [],
    deals: [],
    checkedCanonicalIds: new Set(),
    ...overrides,
  };
}

describe('buildShoppingListFromRows', () => {
  it('returns empty sections and zero totals for a plan with no ingredients', () => {
    const result = buildShoppingListFromRows(inputs());
    expect(result.planId).toBe(1);
    expect(result.weekOf).toBe('2026-07-27');
    expect(result.sections).toEqual([]);
    expect(result.grandTotalOnSale).toBe(0);
    expect(result.grandTotalAll).toBe(0);
  });
});
```

- [ ] **Step 3: Verify the empty-plan test passes**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 1 passed. The stub already returns the empty shape, so the test passes as-is. This baseline confirms the harness is wired up.

- [ ] **Step 4: Add tests for aggregation (ingredients → items)**

Append to `tests/meal-planner/shopping-list.test.ts` inside the same `describe` block:

```ts
  it('produces one line per canonical_id, summing quantities when units match', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 0.5, unit: 'lb' },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    const item = result.sections[0].items[0];
    expect(item.canonicalId).toBe('chicken_breast');
    expect(item.quantity).toBe(1.5);
    expect(item.unit).toBe('lb');
  });

  it('drops the unit when occurrences use mixed units', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'rice', canonicalName: 'Rice', quantity: 2, unit: 'cup' },
          { canonicalId: 'rice', canonicalName: 'Rice', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const item = result.sections[0].items[0];
    expect(item.quantity).toBe(3);
    expect(item.unit).toBeNull();
  });

  it('excludes items whose canonical_id is in the pantry snapshot', () => {
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', quantity: 2, unit: 'tbsp' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const canonicals = result.sections.flatMap((s) => s.items.map((i) => i.canonicalId));
    expect(canonicals).toEqual(['chicken_breast']);
  });

  it('treats null quantity as 0 (skips it from the sum without crashing)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'salt', canonicalName: 'Salt', quantity: null, unit: null },
        ],
      })
    );
    const item = result.sections[0].items[0];
    expect(item.canonicalId).toBe('salt');
    expect(item.quantity).toBe(0);
  });
```

- [ ] **Step 5: Verify tests fail (stub doesn't aggregate yet)**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 4 failed, 1 passed. All 4 new tests fail because the stub returns empty sections.

- [ ] **Step 6: Implement aggregation**

Replace the body of `buildShoppingListFromRows` in `lib/meal-planner/shopping-list.ts`:

```ts
export function buildShoppingListFromRows(inputs: ShoppingListInputs): ShoppingList {
  const pantry = new Set(inputs.pantryCanonicalIds);

  // Aggregate ingredients per canonical_id.
  type Agg = {
    canonicalId: string;
    name: string;
    quantity: number;
    unit: string | null;
    unitSet: boolean; // false = never seen, true = seen at least once
  };
  const byCanonical = new Map<string, Agg>();
  for (const ing of inputs.ingredients) {
    if (pantry.has(ing.canonicalId)) continue;
    const qty = ing.quantity ?? 0;
    const existing = byCanonical.get(ing.canonicalId);
    if (!existing) {
      byCanonical.set(ing.canonicalId, {
        canonicalId: ing.canonicalId,
        name: ing.canonicalName,
        quantity: qty,
        unit: ing.unit,
        unitSet: true,
      });
    } else {
      existing.quantity += qty;
      if (existing.unit !== ing.unit) existing.unit = null;
    }
  }

  // Placeholder wiring: bucket everything into a single "Not on sale" section.
  // The next tests will drive retailer bucketing, pricing, and totals.
  const items: ShoppingListItem[] = [];
  byCanonical.forEach((a) =>
    items.push({
      canonicalId: a.canonicalId,
      name: a.name,
      quantity: a.quantity,
      unit: a.unit,
      salePrice: null,
      regularPrice: null,
      isChecked: false,
    })
  );

  if (items.length === 0) {
    return {
      planId: inputs.planId,
      weekOf: inputs.weekOf,
      grandTotalOnSale: 0,
      grandTotalAll: 0,
      sections: [],
    };
  }

  return {
    planId: inputs.planId,
    weekOf: inputs.weekOf,
    grandTotalOnSale: 0,
    grandTotalAll: 0,
    sections: [{ retailer: NOT_ON_SALE, subtotal: 0, items }],
  };
}
```

- [ ] **Step 7: Verify aggregation tests pass**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 5 passed.

- [ ] **Step 8: Add tests for retailer picking + bucketing**

Append to the `describe` block:

```ts
  it('picks the cheapest retailer per canonical from the deals rows', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'chicken_breast', retailerName: 'sprouts',       salePrice: 3.49, regularPrice: 6.49 },
          { canonicalId: 'chicken_breast', retailerName: 'target',        salePrice: 5.99, regularPrice: 6.99 },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('sprouts');
    expect(result.sections[0].items[0].salePrice).toBe(3.49);
    expect(result.sections[0].items[0].regularPrice).toBe(6.49);
  });

  it('buckets canonicals with a deal row but no sale_price into "Not on sale"', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'basmati_rice', canonicalName: 'Basmati Rice', quantity: 1, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'basmati_rice', retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
        ],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('Not on sale');
    expect(result.sections[0].items[0].salePrice).toBeNull();
    expect(result.sections[0].items[0].regularPrice).toBe(3.99);
  });

  it('buckets canonicals with no deal row at all into "Not on sale" with null prices', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'saffron', canonicalName: 'Saffron', quantity: 1, unit: 'pinch' },
        ],
        deals: [],
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].retailer).toBe('Not on sale');
    expect(result.sections[0].items[0].salePrice).toBeNull();
    expect(result.sections[0].items[0].regularPrice).toBeNull();
  });
```

- [ ] **Step 9: Verify retailer tests fail**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 3 failed, 5 passed.

- [ ] **Step 10: Implement retailer picking and bucketing**

Replace the "Placeholder wiring" block in `buildShoppingListFromRows` with the full retailer logic. The complete new body:

```ts
export function buildShoppingListFromRows(inputs: ShoppingListInputs): ShoppingList {
  const pantry = new Set(inputs.pantryCanonicalIds);

  // 1. Aggregate ingredients per canonical_id.
  type Agg = {
    canonicalId: string;
    name: string;
    quantity: number;
    unit: string | null;
  };
  const byCanonical = new Map<string, Agg>();
  for (const ing of inputs.ingredients) {
    if (pantry.has(ing.canonicalId)) continue;
    const qty = ing.quantity ?? 0;
    const existing = byCanonical.get(ing.canonicalId);
    if (!existing) {
      byCanonical.set(ing.canonicalId, {
        canonicalId: ing.canonicalId,
        name: ing.canonicalName,
        quantity: qty,
        unit: ing.unit,
      });
    } else {
      existing.quantity += qty;
      if (existing.unit !== ing.unit) existing.unit = null;
    }
  }

  // 2. Pick the cheapest deal per canonical.
  // Prefer rows with a sale_price; among those, pick the lowest sale_price.
  // If no rows have a sale_price, pick the lowest regular_price.
  type Pick = { retailer: string; salePrice: number | null; regularPrice: number | null };
  const pickByCanonical = new Map<string, Pick>();
  const dealsByCanonical = new Map<string, ShoppingListInputs['deals'][number][]>();
  for (const d of inputs.deals) {
    const list = dealsByCanonical.get(d.canonicalId) ?? [];
    list.push(d);
    dealsByCanonical.set(d.canonicalId, list);
  }
  dealsByCanonical.forEach((rows, canonicalId) => {
    const onSale = rows.filter((r) => r.salePrice !== null);
    const pool = onSale.length > 0 ? onSale : rows;
    const priceKey = onSale.length > 0
      ? (r: (typeof pool)[number]) => r.salePrice ?? Number.POSITIVE_INFINITY
      : (r: (typeof pool)[number]) => r.regularPrice ?? Number.POSITIVE_INFINITY;
    let best = pool[0];
    for (const r of pool) {
      if (priceKey(r) < priceKey(best)) best = r;
    }
    pickByCanonical.set(canonicalId, {
      retailer: best.retailerName,
      salePrice: best.salePrice,
      regularPrice: best.regularPrice,
    });
  });

  // 3. Bucket items by retailer (or NOT_ON_SALE).
  const bySection = new Map<string, ShoppingListItem[]>();
  byCanonical.forEach((a) => {
    const pick = pickByCanonical.get(a.canonicalId);
    const isChecked = inputs.checkedCanonicalIds.has(a.canonicalId);
    const item: ShoppingListItem = {
      canonicalId: a.canonicalId,
      name: a.name,
      quantity: a.quantity,
      unit: a.unit,
      salePrice: pick?.salePrice ?? null,
      regularPrice: pick?.regularPrice ?? null,
      isChecked,
    };
    const section = pick && pick.salePrice !== null ? pick.retailer : NOT_ON_SALE;
    const list = bySection.get(section) ?? [];
    list.push(item);
    bySection.set(section, list);
  });

  // 4. Compute subtotals and totals; sort items alphabetically within each section.
  const sections: ShoppingListSection[] = [];
  let grandTotalOnSale = 0;
  let grandTotalAll = 0;
  bySection.forEach((items, retailer) => {
    items.sort((a, b) => a.name.localeCompare(b.name));
    let subtotal = 0;
    for (const it of items) {
      if (it.salePrice !== null) {
        const line = Math.ceil(it.quantity) * it.salePrice;
        subtotal += line;
        grandTotalOnSale += line;
      } else if (it.regularPrice !== null) {
        grandTotalAll += Math.ceil(it.quantity) * it.regularPrice;
      }
      // else: no price info; contributes to neither total.
    }
    sections.push({ retailer, subtotal, items });
  });
  grandTotalAll += grandTotalOnSale;

  // 5. Sort sections: on-sale sections by descending subtotal; NOT_ON_SALE always last.
  sections.sort((a, b) => {
    if (a.retailer === NOT_ON_SALE) return 1;
    if (b.retailer === NOT_ON_SALE) return -1;
    return b.subtotal - a.subtotal;
  });

  return {
    planId: inputs.planId,
    weekOf: inputs.weekOf,
    grandTotalOnSale,
    grandTotalAll,
    sections,
  };
}
```

- [ ] **Step 11: Verify retailer tests pass**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 8 passed.

- [ ] **Step 12: Add tests for totals, sorting, and checks**

Append to the `describe` block:

```ts
  it('per-item cost uses ceil(quantity) * salePrice (0.5 lb of $6.99/lb rounds up to $6.99)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 0.5, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 6.99, regularPrice: 8.99 },
        ],
      })
    );
    expect(result.sections[0].subtotal).toBeCloseTo(6.99, 2);
    expect(result.grandTotalOnSale).toBeCloseTo(6.99, 2);
  });

  it('grandTotalAll adds non-sale items priced at regular_price to grandTotalOnSale', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'basmati_rice',   canonicalName: 'Basmati Rice',   quantity: 2, unit: 'lb' },
        ],
        deals: [
          { canonicalId: 'chicken_breast', retailerName: 'harris-teeter', salePrice: 4.99, regularPrice: 5.99 },
          { canonicalId: 'basmati_rice',   retailerName: 'harris-teeter', salePrice: null, regularPrice: 3.99 },
        ],
      })
    );
    expect(result.grandTotalOnSale).toBeCloseTo(4.99, 2);
    expect(result.grandTotalAll).toBeCloseTo(4.99 + 2 * 3.99, 2);
  });

  it('sorts retailer sections by descending on-sale subtotal, with "Not on sale" always last', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'small_ht', canonicalName: 'Small HT', quantity: 1, unit: 'ea' },
          { canonicalId: 'big_sp',   canonicalName: 'Big SP',   quantity: 1, unit: 'ea' },
          { canonicalId: 'unmapped', canonicalName: 'Unmapped', quantity: 1, unit: 'ea' },
        ],
        deals: [
          { canonicalId: 'small_ht', retailerName: 'harris-teeter', salePrice: 1.00, regularPrice: 2.00 },
          { canonicalId: 'big_sp',   retailerName: 'sprouts',       salePrice: 9.99, regularPrice: 12.99 },
        ],
      })
    );
    const retailers = result.sections.map((s) => s.retailer);
    expect(retailers).toEqual(['sprouts', 'harris-teeter', 'Not on sale']);
  });

  it('sorts items alphabetically by name within a section', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'zucchini', canonicalName: 'Zucchini', quantity: 1, unit: 'ea' },
          { canonicalId: 'apple',    canonicalName: 'Apple',    quantity: 1, unit: 'ea' },
        ],
        deals: [
          { canonicalId: 'zucchini', retailerName: 'harris-teeter', salePrice: 1.99, regularPrice: 2.99 },
          { canonicalId: 'apple',    retailerName: 'harris-teeter', salePrice: 0.99, regularPrice: 1.49 },
        ],
      })
    );
    const names = result.sections[0].items.map((i) => i.name);
    expect(names).toEqual(['Apple', 'Zucchini']);
  });

  it('marks items with isChecked=true when their canonical is in checkedCanonicalIds', () => {
    const result = buildShoppingListFromRows(
      inputs({
        ingredients: [
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
          { canonicalId: 'rice',           canonicalName: 'Rice',           quantity: 1, unit: 'cup' },
        ],
        checkedCanonicalIds: new Set(['chicken_breast']),
      })
    );
    const flat = result.sections.flatMap((s) => s.items);
    const chicken = flat.find((i) => i.canonicalId === 'chicken_breast');
    const rice = flat.find((i) => i.canonicalId === 'rice');
    expect(chicken?.isChecked).toBe(true);
    expect(rice?.isChecked).toBe(false);
  });
```

- [ ] **Step 13: Verify all tests pass**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
```

Expected: 13 passed. The implementation from Step 10 already covers all of these behaviors, so they should pass without further code changes. If any fail, fix the implementation before moving on — do not commit failing tests.

- [ ] **Step 14: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors in `lib/meal-planner/shopping-list.ts` or `tests/meal-planner/shopping-list.test.ts`.

- [ ] **Step 15: Commit**

```bash
git add lib/meal-planner/shopping-list.ts tests/meal-planner/shopping-list.test.ts
git commit -m "Add buildShoppingListFromRows pure aggregation with unit tests"
```

---

## Task 4: `buildShoppingList` — async orchestrator that fetches from Supabase

**Files:**
- Modify: `lib/meal-planner/shopping-list.ts`

**Context:** Add a thin `async` function that fetches the four inputs (plan row, meal_ingredients, deals, checks) from Supabase and calls the pure `buildShoppingListFromRows`. No unit tests — the async orchestrator is verified by the local + prod smoke tests in Task 6, matching the pattern for `getPlannerInput` and `getCurrentWeekPlan` (also un-tested).

- [ ] **Step 1: Add the orchestrator**

Append to `lib/meal-planner/shopping-list.ts`:

```ts
import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';

export async function buildShoppingList(planId: number): Promise<ShoppingList> {
  const supabase = getServerClient();

  // 1. Plan row (week_of + pantry snapshot).
  const { data: planRow, error: planErr } = await supabase
    .from('meal_plans')
    .select('id, week_of, pantry_canonical_ingredient_ids')
    .eq('id', planId)
    .single();
  if (planErr || !planRow) {
    throw planErr ?? new Error(`meal_plans row not found for id=${planId}`);
  }

  // 2. Ingredients across every meal in this plan (breakfast/lunch/dinner + snacks).
  const { data: ingRows, error: ingErr } = await supabase
    .from('meals')
    .select(
      `id,
       meal_ingredients (canonical_ingredient_id, quantity, unit,
         canonical_ingredients (name))`
    )
    .eq('meal_plan_id', planId);
  if (ingErr) throw ingErr;

  type MealRow = {
    id: number;
    meal_ingredients: Array<{
      canonical_ingredient_id: string;
      quantity: number | null;
      unit: string | null;
      canonical_ingredients: { name: string } | null;
    }>;
  };
  const ingredients = ((ingRows ?? []) as unknown as MealRow[]).flatMap((meal) =>
    (meal.meal_ingredients ?? []).map((ing) => ({
      canonicalId: ing.canonical_ingredient_id,
      canonicalName: ing.canonical_ingredients?.name ?? ing.canonical_ingredient_id,
      quantity: ing.quantity,
      unit: ing.unit,
    }))
  );

  // 3. Deals for the current week — include rows with null sale_price so we
  //    can compute grandTotalAll from regular_price. This is why we don't
  //    reuse getCurrentWeekOnSaleDeals (which filters non-sale rows out).
  const weekOf = getCurrentWeekOfISO();
  const { data: dealRows, error: dealErr } = await supabase
    .from('deals')
    .select(
      `sale_price, regular_price,
       retailer_skus!inner (canonical_ingredient_id,
         retailers!inner (name))`
    )
    .eq('week_of', weekOf);
  if (dealErr) throw dealErr;

  type DealRow = {
    sale_price: number | null;
    regular_price: number | null;
    retailer_skus: {
      canonical_ingredient_id: string | null;
      retailers: { name: string };
    };
  };
  const deals = ((dealRows ?? []) as unknown as DealRow[])
    .filter((r) => r.retailer_skus.canonical_ingredient_id !== null)
    .map((r) => ({
      canonicalId: r.retailer_skus.canonical_ingredient_id as string,
      retailerName: r.retailer_skus.retailers.name,
      salePrice: r.sale_price,
      regularPrice: r.regular_price,
    }));

  // 4. Checked canonical_ids for this plan.
  const { data: checkRows, error: checkErr } = await supabase
    .from('shopping_list_checks')
    .select('canonical_ingredient_id')
    .eq('meal_plan_id', planId);
  if (checkErr) throw checkErr;
  const checkedCanonicalIds = new Set(
    ((checkRows ?? []) as Array<{ canonical_ingredient_id: string }>).map(
      (r) => r.canonical_ingredient_id
    )
  );

  return buildShoppingListFromRows({
    planId,
    weekOf: planRow.week_of as string,
    pantryCanonicalIds:
      (planRow.pantry_canonical_ingredient_ids as string[] | null) ?? [],
    ingredients,
    deals,
    checkedCanonicalIds,
  });
}
```

- [ ] **Step 2: Typecheck and run all tests**

```bash
npx tsc --noEmit
npm test -- --run tests/meal-planner/
```

Expected: no new tsc errors; all meal-planner tests pass (including the 13 from Task 3).

- [ ] **Step 3: Commit**

```bash
git add lib/meal-planner/shopping-list.ts
git commit -m "Add buildShoppingList async orchestrator (Supabase fetches)"
```

---

## Task 5: `/plan/shopping-list` route — page, Server Action, checkbox, entry link

**Files:**
- Create: `app/plan/shopping-list/page.tsx`
- Create: `app/plan/shopping-list/actions.ts`
- Create: `app/plan/shopping-list/ShoppingItemCheckbox.tsx`
- Modify: `app/plan/page.tsx`

**Context:** Look at `app/plan/page.tsx` for the styling and structure conventions (Tailwind classes, layout wrappers, header shapes). Match the visual language used there — this feature is meant to feel like part of the same app, not a new one.

- [ ] **Step 1: Create the Server Action**

Create `app/plan/shopping-list/actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function toggleShoppingItem(
  planId: number,
  canonicalId: string,
  nextChecked: boolean
): Promise<void> {
  const supabase = getServerClient();
  if (nextChecked) {
    const { error } = await supabase
      .from('shopping_list_checks')
      .upsert({ meal_plan_id: planId, canonical_ingredient_id: canonicalId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .eq('canonical_ingredient_id', canonicalId);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
}
```

- [ ] **Step 2: Create the Client Component checkbox**

Create `app/plan/shopping-list/ShoppingItemCheckbox.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { toggleShoppingItem } from './actions';

export function ShoppingItemCheckbox({
  planId,
  canonicalId,
  initialChecked,
  children,
}: {
  planId: number;
  canonicalId: string;
  initialChecked: boolean;
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [pending, startTransition] = useTransition();

  return (
    <label
      className={`flex items-center gap-3 py-1 cursor-pointer ${
        checked ? 'line-through opacity-60' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setChecked(next);
          startTransition(async () => {
            try {
              await toggleShoppingItem(planId, canonicalId, next);
            } catch {
              setChecked(!next);
            }
          });
        }}
      />
      <span className="flex-1">{children}</span>
    </label>
  );
}
```

- [ ] **Step 3: Create the page (Server Component)**

Create `app/plan/shopping-list/page.tsx`:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';
import { buildShoppingList } from '@/lib/meal-planner/shopping-list';
import { ShoppingItemCheckbox } from './ShoppingItemCheckbox';

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

function qty(quantity: number, unit: string | null): string {
  if (quantity === 0 && unit === null) return '';
  const q = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2);
  return unit ? `${q} ${unit}` : q;
}

export default async function ShoppingListPage() {
  const supabase = getServerClient();
  const weekOf = getCurrentWeekOfISO();

  const { data: planRow } = await supabase
    .from('meal_plans')
    .select('id')
    .eq('week_of', weekOf)
    .maybeSingle();

  if (!planRow) {
    // No plan yet — send user to /plan where they'll see the empty-state generate button.
    redirect('/plan');
  }

  const list = await buildShoppingList(planRow.id as number);

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Shopping List</h1>
        <p className="text-sm text-gray-500">Week of {list.weekOf}</p>
        <p className="mt-2 text-sm">
          Estimated:{' '}
          <span className="font-medium">{fmt(list.grandTotalOnSale)} on sale</span>
          {' / '}
          <span className="font-medium">{fmt(list.grandTotalAll)} total</span>
        </p>
      </header>

      {list.sections.length === 0 ? (
        <p className="text-gray-500">Nothing to buy — every ingredient is in your pantry.</p>
      ) : (
        list.sections.map((section) => (
          <section key={section.retailer} className="mb-6">
            <h2 className="text-lg font-semibold border-b pb-1 mb-2">
              {section.retailer}
              {section.subtotal > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {fmt(section.subtotal)} on sale
                </span>
              )}
            </h2>
            <ul>
              {section.items.map((item) => (
                <li key={item.canonicalId}>
                  <ShoppingItemCheckbox
                    planId={list.planId}
                    canonicalId={item.canonicalId}
                    initialChecked={item.isChecked}
                  >
                    <span>{item.name}</span>
                    <span className="text-sm text-gray-500">
                      {qty(item.quantity, item.unit) && ` · ${qty(item.quantity, item.unit)}`}
                      {item.salePrice !== null && ` · ${fmt(item.salePrice)}`}
                      {item.salePrice === null && item.regularPrice !== null &&
                        ` · ${fmt(item.regularPrice)} (regular)`}
                      {item.salePrice === null && item.regularPrice === null && ' · —'}
                    </span>
                  </ShoppingItemCheckbox>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 4: Add the entry link on `/plan`**

Open `app/plan/page.tsx`. `Link` is already imported (line 1). Locate the flex row that holds `<RegenerateButton />` and the `← Deals` link (currently around lines 87-92). Insert a new `Shopping list` link between them so the row becomes:

```tsx
        <div className="flex items-center gap-3">
          <RegenerateButton />
          <Link
            href="/plan/shopping-list"
            className="text-sm text-neutral-500 hover:underline"
          >
            Shopping list
          </Link>
          <Link href="/" className="text-sm text-neutral-500 hover:underline">
            ← Deals
          </Link>
        </div>
```

The new link uses the same Tailwind classes as the neighboring `← Deals` link so it visually matches. Do not add it to the empty-state block (lines 62-80) — the shopping list makes no sense before there's a plan.

- [ ] **Step 5: Typecheck and build**

```bash
npx tsc --noEmit
npm run build
```

Expected: `tsc` reports no new errors under `app/plan/` or `lib/meal-planner/`. `next build` completes without errors and lists `/plan/shopping-list` as a route in the summary.

- [ ] **Step 6: Commit**

```bash
git add app/plan/shopping-list/ app/plan/page.tsx
git commit -m "Add /plan/shopping-list route with Server Action checkbox"
```

---

## Task 6: Local smoke test, deploy, prod smoke test, memory update

**Files:**
- Modify: `~/.claude/projects/-Users-jasonlee/memory/project_grocery_planner.md`

- [ ] **Step 1: Local smoke test**

Start the dev server:

```bash
npm run dev
```

In another terminal, or in a browser:
1. Open `http://localhost:3000/plan` — log in with `SHARED_PASSWORD` if prompted.
2. If no plan exists for the current week, click Generate and wait. Confirm the plan renders.
3. Click the "Shopping list" link. Verify:
   - The page loads at `/plan/shopping-list`.
   - Retailer sections appear (or "Not on sale" if the current deals data is thin).
   - Per-item quantities and prices render.
   - Grand total ("Estimated: $X on sale / $Y total") appears in the header.
4. Check 2 items. Refresh the page. Verify the same items are still checked.
5. Uncheck one. Refresh. Verify it's unchecked.
6. Return to `/plan`, click Regenerate, confirm. When the new plan loads, click "Shopping list" again. Verify all previously checked items are now unchecked (cascade fired).

Stop the dev server (`Ctrl-C`).

- [ ] **Step 2: Merge and push**

```bash
git checkout main
git merge --no-ff shopping-list -m "Merge shopping-list: /plan/shopping-list with persistent checks"
git push origin main
```

- [ ] **Step 3: Watch the Vercel deploy**

```bash
vercel ls grocery-planner --limit 3
```

Wait until the latest deployment shows **Ready** (Vercel auto-deploys on push to `main`, usually 1–2 min).

If it fails: check logs with `vercel logs <deployment-url> --limit 100`. Fix locally, commit, push, wait again. Do not proceed until Ready.

- [ ] **Step 4: Prod smoke test**

Open `https://grocery-planner-omega.vercel.app/plan/shopping-list` in a browser. Log in.

Repeat the local smoke test steps (check items, refresh, regenerate, verify cascade). Also test on a phone (or a second browser) to confirm cross-device sync: check an item on desktop, refresh on phone, verify the check shows up.

If anything fails: check `vercel logs <deployment-url> --limit 200` for stack traces. Fix locally on a new branch, PR, merge, redeploy.

- [ ] **Step 5: Update the project memory**

Edit `~/.claude/projects/-Users-jasonlee/memory/project_grocery_planner.md`. Add a bullet under the plans list and update the "Status" line. The additions:

```
- Shopping-list plan (completed 2026-07-30): `docs/superpowers/plans/2026-07-30-shopping-list.md`. Adds `/plan/shopping-list` interactive checklist grouped by retailer, with per-item sale prices and grand totals. New `shopping_list_checks` table (PK `(meal_plan_id, canonical_ingredient_id)`, cascade on plan delete); new `meal_plans.pantry_canonical_ingredient_ids TEXT[]` snapshot column. Dropped unused Week 1 `shopping_lists` / `shopping_list_items` tables. Migration `0002_shopping_list.sql`. Server Action + optimistic checkbox (`app/plan/shopping-list/`).
```

Update the "Status (as of …)" line to mention the new route.

- [ ] **Step 6: Commit the memory update**

No git commit (memory lives outside the repo). Just save the file — the memory system reads it directly on future sessions.

---

## Rollback

If something breaks in prod and needs an urgent revert:

```bash
git revert -m 1 <merge-sha>   # revert the merge commit
git push origin main
```

Vercel auto-redeploys the reverted `main`. The `0002_shopping_list.sql` migration stays applied in Supabase — that's safe (the new column defaults to `{}` and the checks table is unused if the code isn't there), but if you want a clean DB rollback too:

```sql
drop table if exists shopping_list_checks;
alter table meal_plans drop column if exists pantry_canonical_ingredient_ids;
-- (The dropped Week 1 tables stay dropped; they were unused anyway.)
```

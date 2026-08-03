# Week 2b — Pasta Family Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll up pasta shapes into a single "Pasta" row on the shopping list while preserving shape-specific naming in recipes.

**Architecture:** Add a nullable `shopping_group` column on `canonical_ingredients`. All Italian pasta shapes get `shopping_group='pasta'`. The shopping-list aggregator groups by `shopping_group ?? canonical_id`; the cheapest deal across group members becomes the buy recommendation. Meal plans and recipes are unchanged — they continue to reference specific shape canonicals.

**Tech Stack:** Next.js 14 App Router (Server Components + Server Actions), Supabase Postgres, Vitest with `vi.mock`.

**Spec:** `docs/superpowers/specs/2026-08-03-week-2b-pasta-family-grouping-design.md`

**Branch:** `week-2b-pasta-family-grouping` (already created)

---

## File Structure

**New files:**
- `supabase/migrations/0004_shopping_group.sql` — column addition
- `tests/canonical-ingredients/seed.test.ts` — seed sanity test

**Modified files:**
- `lib/db/types.ts` — add `shopping_group` to `CanonicalIngredient`
- `lib/canonical-ingredients/seed-data.ts` — add `shopping_group: 'pasta'` to 6 pasta shape rows
- `lib/normalization/canonical.ts` — extend `CanonicalMini` and select
- `lib/meal-planner/shopping-list.ts` — new grouping key, extended input/output types, group-aware cheapest-deal selection, usage sub-line data
- `tests/meal-planner/shopping-list.test.ts` — 6 new cases for group aggregation
- `app/plan/shopping-list/actions.ts` — `toggleShoppingItem` accepts `memberCanonicalIds: string[]`
- `app/plan/shopping-list/ShoppingItemCheckbox.tsx` — pass `memberCanonicalIds` through
- `app/plan/shopping-list/page.tsx` — render family display name, "cheapest: X @ retailer" and "used in: …" sub-lines
- `tests/api/toggle-shopping-item.test.ts` — new tests for group check-on/check-off (create if missing)

---

## Task 0: Preflight

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch and clean tree**

Run: `git branch --show-current && git status`
Expected: `week-2b-pasta-family-grouping`, working tree clean (spec commit `da8f4a3` is present).

- [ ] **Step 2: Baseline test run**

Run: `npm test`
Expected: 174 tests pass across 24 files (post-Week 5c baseline). Note this as your regression floor.

- [ ] **Step 3: Baseline typecheck (known pre-existing errors)**

Run: `npx tsc --noEmit`
Expected: 9 errors in `tests/ingestion/harris-teeter/{locations,products}.test.ts` and `tests/normalization/runner.test.ts`. These exist on `main` and are not this plan's concern. Do NOT let the count grow past 9.

- [ ] **Step 4: Verify remote Supabase is at migration 0003**

Open the Supabase SQL editor and run:

```sql
select column_name
from information_schema.columns
where table_name = 'canonical_ingredients'
order by ordinal_position;
```

Expected: columns include `id, name, category, default_unit, aisle_group` but NOT `shopping_group`. If `shopping_group` already exists, stop and coordinate with the user.

Also verify `job_runs` exists (proves 0003 has been applied):

```sql
select 1 from information_schema.tables where table_name = 'job_runs';
```

Expected: 1 row.

---

## Task 1: Migration + `CanonicalIngredient` type field

**Files:**
- Create: `supabase/migrations/0004_shopping_group.sql`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/0004_shopping_group.sql`:

```sql
-- 0004_shopping_group.sql
-- Optional grouping key for the shopping-list aggregator. When set, multiple
-- canonicals with the same shopping_group value roll up into one shopping-list
-- row (e.g., pasta_penne + pasta_rigatoni → "Pasta"). NULL means "aggregate as
-- itself" — the default and current behavior.
alter table canonical_ingredients
  add column shopping_group text null;
```

- [ ] **Step 2: Apply the migration in the Supabase SQL editor**

Paste the contents of `0004_shopping_group.sql` into the Supabase SQL editor and run. Verify success. Then re-verify:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'canonical_ingredients' and column_name = 'shopping_group';
```

Expected: one row — `shopping_group | text | YES`.

- [ ] **Step 3: Add `shopping_group` to `CanonicalIngredient` in `lib/db/types.ts`**

Find the existing `CanonicalIngredient` type. Add `shopping_group` at the end:

```typescript
export type CanonicalIngredient = {
  id: string;
  name: string;
  category: string | null;
  default_unit: string | null;
  aisle_group: string | null;
  shopping_group: string | null; // NEW — nullable group key for shopping-list rollup
};
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors (unchanged). No new errors introduced.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_shopping_group.sql lib/db/types.ts
git commit -m "Add nullable shopping_group column to canonical_ingredients"
```

---

## Task 2: Seed sanity test (TDD — test first)

**Files:**
- Create: `tests/canonical-ingredients/seed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/canonical-ingredients/seed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

const byId = new Map(CANONICAL_INGREDIENTS.map((c) => [c.id, c]));

const PASTA_SHAPES = [
  'pasta_spaghetti',
  'pasta_penne',
  'pasta_rigatoni',
  'pasta_farfalle',
  'pasta_orzo',
  'pasta_linguine',
] as const;

// Explicitly ungrouped — either not Italian pasta shapes (noodles, sauce) or
// not substitutable at the shopping-list level.
const EXPLICITLY_UNGROUPED = [
  'noodle_ramen',
  'noodle_udon',
  'noodle_rice',
  'lasagna_noodle',
  'pasta_sauce_jar',
] as const;

describe('canonical ingredients seed — shopping_group', () => {
  it('assigns shopping_group="pasta" to every Italian pasta shape', () => {
    for (const id of PASTA_SHAPES) {
      const row = byId.get(id);
      expect(row, `${id} missing from seed data`).toBeDefined();
      expect(row?.shopping_group, `${id} should be in pasta group`).toBe('pasta');
    }
  });

  it('keeps noodles, lasagna noodles, and pasta sauce ungrouped', () => {
    for (const id of EXPLICITLY_UNGROUPED) {
      const row = byId.get(id);
      expect(row, `${id} missing from seed data`).toBeDefined();
      expect(row?.shopping_group, `${id} must not be grouped`).toBeNull();
    }
  });

  it('does not set shopping_group on any non-listed row (guard against typos)', () => {
    const allowed = new Set<string>(['pasta']);
    const offenders = CANONICAL_INGREDIENTS.filter(
      (c) => c.shopping_group !== null && !allowed.has(c.shopping_group)
    );
    expect(offenders, 'unexpected shopping_group values found').toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/canonical-ingredients/seed.test.ts`
Expected: FAIL — the first test errors because `row?.shopping_group` is `undefined` (field doesn't exist in seed literals yet) and does not equal `'pasta'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/canonical-ingredients/seed.test.ts
git commit -m "Add seed sanity test for pasta shopping_group"
```

---

## Task 3: Seed data update + apply to remote

**Files:**
- Modify: `lib/canonical-ingredients/seed-data.ts`

- [ ] **Step 1: Add `shopping_group: 'pasta'` to the 6 pasta shape rows**

Open `lib/canonical-ingredients/seed-data.ts`. Find the block of pasta rows (around line 119). For EACH of the 6 rows listed below, add `, shopping_group: 'pasta'` immediately before the closing `}`.

Before:
```typescript
{ id: 'pasta_spaghetti', name: 'Spaghetti', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
{ id: 'pasta_penne', name: 'Penne', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
{ id: 'pasta_rigatoni', name: 'Rigatoni', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
{ id: 'pasta_farfalle', name: 'Farfalle', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
{ id: 'pasta_orzo', name: 'Orzo', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
{ id: 'pasta_linguine', name: 'Linguine', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry' },
```

After:
```typescript
{ id: 'pasta_spaghetti', name: 'Spaghetti', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
{ id: 'pasta_penne', name: 'Penne', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
{ id: 'pasta_rigatoni', name: 'Rigatoni', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
{ id: 'pasta_farfalle', name: 'Farfalle', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
{ id: 'pasta_orzo', name: 'Orzo', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
{ id: 'pasta_linguine', name: 'Linguine', category: 'pasta', default_unit: 'lb', aisle_group: 'pantry', shopping_group: 'pasta' },
```

Do NOT modify `lasagna_noodle`, `noodle_ramen`, `noodle_udon`, `noodle_rice`, or `pasta_sauce_jar`.

- [ ] **Step 2: Add `shopping_group: null` to every OTHER row in the seed file**

Because `CanonicalIngredient` now requires `shopping_group: string | null`, every literal must include the field. Global-replace in `lib/canonical-ingredients/seed-data.ts`:

- For each row that does NOT end in `shopping_group: 'pasta' },`, add `, shopping_group: null` before the closing `}`.

The mechanical rule: any row of shape `{ id: '<id>', name: '<name>', ..., aisle_group: '<x>' }` that lacks `shopping_group` needs `, shopping_group: null` appended.

Fastest verification after editing: run `npx tsc --noEmit` — TypeScript will flag any literal missing the field.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors (the same pre-existing ones). Any new error means a seed row is missing `shopping_group`.

- [ ] **Step 4: Run the seed sanity test — verify it now passes**

Run: `npm test -- tests/canonical-ingredients/seed.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `npm test`
Expected: 174 + 3 = 177 tests pass (Week 5c baseline + 3 new seed tests).

- [ ] **Step 6: Push seed to remote Supabase**

Run: `npm run seed`
Expected: prints `Seeding N canonical ingredients…` then `Seed complete.` The upsert uses `onConflict: 'id'`, so existing rows are updated in place with the new `shopping_group` value.

Then verify in the Supabase SQL editor:

```sql
select id, name, shopping_group
from canonical_ingredients
where shopping_group is not null
order by id;
```

Expected: 6 rows — the pasta shapes with `shopping_group = 'pasta'`.

- [ ] **Step 7: Commit**

```bash
git add lib/canonical-ingredients/seed-data.ts
git commit -m "Seed: assign shopping_group='pasta' to Italian pasta shapes"
```

---

## Task 4: Extend canonical cache to return `shopping_group`

**Files:**
- Modify: `lib/normalization/canonical.ts`

- [ ] **Step 1: Extend `CanonicalMini` and the select**

Open `lib/normalization/canonical.ts`. Replace the file with:

```typescript
import { getServerClient } from '@/lib/db/client';

export type CanonicalMini = {
  id: string;
  name: string;
  category: string | null;
  shopping_group: string | null;
};

let cache: CanonicalMini[] | null = null;

export async function getCanonicalIngredients(): Promise<CanonicalMini[]> {
  if (cache) return cache;
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('canonical_ingredients')
    .select('id, name, category, shopping_group');
  if (error) throw error;
  cache = (data ?? []) as CanonicalMini[];
  return cache;
}

// For tests
export function _resetCanonicalCache() {
  cache = null;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors. No new errors — mapper.ts already treats the list opaquely by `id`/`name`/`category`.

- [ ] **Step 3: Commit**

```bash
git add lib/normalization/canonical.ts
git commit -m "canonical cache: include shopping_group in mini shape"
```

---

## Task 5: Shopping-list aggregator — types + first rollup test (TDD)

**Files:**
- Modify: `lib/meal-planner/shopping-list.ts`
- Modify: `tests/meal-planner/shopping-list.test.ts`

- [ ] **Step 1: Update `ShoppingListInputs`, `ShoppingListItem`, and add helper type**

Replace the top of `lib/meal-planner/shopping-list.ts` (lines 1–46) with:

```typescript
import { getServerClient } from '@/lib/db/client';

export type ShoppingListInputs = {
  planId: number;
  weekOf: string;
  pantryCanonicalIds: readonly string[];
  ingredients: ReadonlyArray<{
    canonicalId: string;
    canonicalName: string;
    shoppingGroup: string | null;
    quantity: number | null;
    unit: string | null;
    mealName: string;
    mealDay: string;
  }>;
  deals: ReadonlyArray<{
    canonicalId: string;
    shoppingGroup: string | null;
    retailerName: string;
    salePrice: number | null;
    regularPrice: number | null;
  }>;
  checkedCanonicalIds: ReadonlySet<string>;
};

export type ShoppingListItemUsage = {
  mealDay: string;
  mealName: string;
  canonicalId: string;
  canonicalDisplayName: string;
};

export type ShoppingListItem = {
  groupKey: string;                        // shopping_group ?? canonicalId
  displayName: string;                     // family display name or canonical name
  memberCanonicalIdsInUse: string[];       // for the server action
  usage: ShoppingListItemUsage[];          // "used in: …" sub-line data
  quantity: number;
  unit: string | null;
  salePrice: number | null;                // cheapest member's sale price (or null)
  regularPrice: number | null;             // cheapest member's regular price (or null)
  cheapestMemberCanonicalId: string;       // "cheapest: X" recommendation
  cheapestMemberDisplayName: string;
  isChecked: boolean;                      // true iff EVERY member-in-use is checked
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

// In-code map from shopping_group slug to display name. Add entries here when
// new groups are introduced (e.g., butter, ground_beef).
const GROUP_DISPLAY_NAMES: Record<string, string> = {
  pasta: 'Pasta',
};
```

- [ ] **Step 2: Write the first failing test**

Open `tests/meal-planner/shopping-list.test.ts`. Add these helpers near the top (if not already present) and the first new test:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildShoppingListFromRows,
  type ShoppingListInputs,
} from '@/lib/meal-planner/shopping-list';

function ing(
  overrides: Partial<ShoppingListInputs['ingredients'][number]> = {}
): ShoppingListInputs['ingredients'][number] {
  return {
    canonicalId: 'x',
    canonicalName: 'X',
    shoppingGroup: null,
    quantity: 1,
    unit: 'lb',
    mealName: 'Meal',
    mealDay: 'Monday',
    ...overrides,
  };
}

function deal(
  overrides: Partial<ShoppingListInputs['deals'][number]> = {}
): ShoppingListInputs['deals'][number] {
  return {
    canonicalId: 'x',
    shoppingGroup: null,
    retailerName: 'Harris Teeter',
    salePrice: 1.99,
    regularPrice: 2.49,
    ...overrides,
  };
}

describe('buildShoppingListFromRows — group rollup', () => {
  it('rolls two pasta shapes into a single "Pasta" row', () => {
    const list = buildShoppingListFromRows({
      planId: 1,
      weekOf: '2026-08-03',
      pantryCanonicalIds: [],
      checkedCanonicalIds: new Set(),
      ingredients: [
        ing({
          canonicalId: 'pasta_penne',
          canonicalName: 'Penne',
          shoppingGroup: 'pasta',
          quantity: 1,
          mealName: 'Vodka',
          mealDay: 'Wednesday',
        }),
        ing({
          canonicalId: 'pasta_rigatoni',
          canonicalName: 'Rigatoni',
          shoppingGroup: 'pasta',
          quantity: 1,
          mealName: 'Bolognese',
          mealDay: 'Monday',
        }),
      ],
      deals: [
        deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: 1.99, regularPrice: 2.49 }),
        deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', salePrice: 2.49, regularPrice: 2.99 }),
      ],
    });

    // One "Harris Teeter" section, one item (the rolled-up pasta).
    const section = list.sections.find((s) => s.retailer === 'Harris Teeter');
    expect(section, 'expected Harris Teeter section').toBeDefined();
    expect(section?.items).toHaveLength(1);

    const row = section!.items[0];
    expect(row.groupKey).toBe('pasta');
    expect(row.displayName).toBe('Pasta');
    expect(row.quantity).toBe(2);
    expect(row.memberCanonicalIdsInUse.sort()).toEqual(['pasta_penne', 'pasta_rigatoni']);
    expect(row.cheapestMemberCanonicalId).toBe('pasta_penne');
    expect(row.cheapestMemberDisplayName).toBe('Penne');
    expect(row.salePrice).toBe(1.99);

    // Subtotal = ceil(2) * 1.99 = 3.98.
    expect(section?.subtotal).toBeCloseTo(3.98, 2);
    expect(list.grandTotalOnSale).toBeCloseTo(3.98, 2);
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: FAIL — either `buildShoppingListFromRows` errors because inputs shape changed (extra properties), or the returned item lacks `groupKey`/`displayName`/etc.

Note: existing tests in this file also fail because their `ing()`/`deal()` helpers (or literal shapes) don't include the new `shoppingGroup`/`mealName`/`mealDay` fields. That's expected and will be addressed in the next step.

- [ ] **Step 4: Reimplement `buildShoppingListFromRows`**

Replace the body of `buildShoppingListFromRows` in `lib/meal-planner/shopping-list.ts` (lines 48 through the end of the function, before `export type PlanRow`) with:

```typescript
export function buildShoppingListFromRows(inputs: ShoppingListInputs): ShoppingList {
  const pantry = new Set(inputs.pantryCanonicalIds);

  // 1. Aggregate ingredients per groupKey = shoppingGroup ?? canonicalId.
  type Agg = {
    groupKey: string;
    displayName: string;
    memberCanonicalIdsInUse: Set<string>;
    memberIdToName: Map<string, string>;
    usage: ShoppingListItemUsage[];
    quantity: number;
    unit: string | null;
  };
  const byGroup = new Map<string, Agg>();
  for (const ing of inputs.ingredients) {
    if (pantry.has(ing.canonicalId)) continue;
    const groupKey = ing.shoppingGroup ?? ing.canonicalId;
    const displayName =
      ing.shoppingGroup !== null
        ? (GROUP_DISPLAY_NAMES[ing.shoppingGroup] ?? ing.canonicalName)
        : ing.canonicalName;
    const qty = ing.quantity ?? 0;
    let agg = byGroup.get(groupKey);
    if (!agg) {
      agg = {
        groupKey,
        displayName,
        memberCanonicalIdsInUse: new Set(),
        memberIdToName: new Map(),
        usage: [],
        quantity: 0,
        unit: ing.unit,
      };
      byGroup.set(groupKey, agg);
    } else if (agg.unit !== ing.unit) {
      agg.unit = null;
    }
    agg.memberCanonicalIdsInUse.add(ing.canonicalId);
    agg.memberIdToName.set(ing.canonicalId, ing.canonicalName);
    agg.usage.push({
      mealDay: ing.mealDay,
      mealName: ing.mealName,
      canonicalId: ing.canonicalId,
      canonicalDisplayName: ing.canonicalName,
    });
    agg.quantity += qty;
  }

  // 2. Pick the cheapest deal across all members of each group.
  // Same rule as before: prefer any sale price; among sale rows, lowest price wins.
  // Fall back to lowest regular_price if no member has a sale price.
  type Pick = {
    retailer: string;
    salePrice: number | null;
    regularPrice: number | null;
    cheapestMemberCanonicalId: string;
  };
  const dealsByGroup = new Map<string, ShoppingListInputs['deals'][number][]>();
  for (const d of inputs.deals) {
    const key = d.shoppingGroup ?? d.canonicalId;
    const list = dealsByGroup.get(key) ?? [];
    list.push(d);
    dealsByGroup.set(key, list);
  }
  const pickByGroup = new Map<string, Pick>();
  dealsByGroup.forEach((rows, groupKey) => {
    const onSale = rows.filter((r) => r.salePrice !== null);
    const pool = onSale.length > 0 ? onSale : rows;
    const priceKey = onSale.length > 0
      ? (r: (typeof pool)[number]) => r.salePrice ?? Number.POSITIVE_INFINITY
      : (r: (typeof pool)[number]) => r.regularPrice ?? Number.POSITIVE_INFINITY;
    let best = pool[0];
    for (const r of pool) {
      if (priceKey(r) < priceKey(best)) best = r;
    }
    pickByGroup.set(groupKey, {
      retailer: best.retailerName,
      salePrice: best.salePrice,
      regularPrice: best.regularPrice,
      cheapestMemberCanonicalId: best.canonicalId,
    });
  });

  // 3. Bucket items by retailer (or NOT_ON_SALE).
  const bySection = new Map<string, ShoppingListItem[]>();
  byGroup.forEach((agg) => {
    const pick = pickByGroup.get(agg.groupKey);
    const memberIds = Array.from(agg.memberCanonicalIdsInUse);
    const isChecked =
      memberIds.length > 0 &&
      memberIds.every((id) => inputs.checkedCanonicalIds.has(id));

    // Cheapest-member display name: prefer the deal's canonical, then any usage
    // occurrence, then the group's own display name.
    const cheapestCanonicalId =
      pick?.cheapestMemberCanonicalId ?? memberIds[0] ?? agg.groupKey;
    const cheapestDisplayName =
      agg.memberIdToName.get(cheapestCanonicalId) ?? agg.displayName;

    const item: ShoppingListItem = {
      groupKey: agg.groupKey,
      displayName: agg.displayName,
      memberCanonicalIdsInUse: memberIds,
      usage: agg.usage,
      quantity: agg.quantity,
      unit: agg.unit,
      salePrice: pick?.salePrice ?? null,
      regularPrice: pick?.regularPrice ?? null,
      cheapestMemberCanonicalId: cheapestCanonicalId,
      cheapestMemberDisplayName: cheapestDisplayName,
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
    items.sort((a, b) => a.displayName.localeCompare(b.displayName));
    let subtotal = 0;
    for (const it of items) {
      if (it.salePrice !== null) {
        const line = Math.ceil(it.quantity) * it.salePrice;
        subtotal += line;
        grandTotalOnSale += line;
      } else if (it.regularPrice !== null) {
        grandTotalAll += Math.ceil(it.quantity) * it.regularPrice;
      }
    }
    sections.push({ retailer, subtotal, items });
  });
  grandTotalAll += grandTotalOnSale;

  // 5. Sort sections: on-sale by descending subtotal, NOT_ON_SALE always last.
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

- [ ] **Step 5: Update the existing tests in `shopping-list.test.ts` to match new input/output shape**

The existing tests will still fail because their input literals lack `shoppingGroup`/`mealName`/`mealDay` on ingredients, `shoppingGroup` on deals, and their expected output uses `canonicalId`/`name` fields that no longer exist on `ShoppingListItem` (now `groupKey`/`displayName`/etc).

Do a mechanical pass:

- For every ingredient literal, add `shoppingGroup: null, mealName: 'Meal', mealDay: 'Monday'` (values don't matter for existing tests — they don't assert on them).
- For every deal literal, add `shoppingGroup: null`.
- For every expected item field access, replace:
  - `item.canonicalId` → `item.groupKey`
  - `item.name` → `item.displayName`

Preserve every assertion's intent — do not delete tests. If two existing tests broke because the type shape changed, both should now pass with the mechanical rename since ungrouped canonicals produce `groupKey === canonicalId` and `displayName === canonicalName`.

- [ ] **Step 6: Run test — verify the first new test passes and existing tests pass again**

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: all existing tests + the new "rolls two pasta shapes into a single Pasta row" test pass.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors. No new errors.

- [ ] **Step 8: Commit**

```bash
git add lib/meal-planner/shopping-list.ts tests/meal-planner/shopping-list.test.ts
git commit -m "Shopping list: group-aware aggregation for pasta rollup"
```

---

## Task 6: Additional aggregator test cases

**Files:**
- Modify: `tests/meal-planner/shopping-list.test.ts`

Each of these tests should be added to the `describe('buildShoppingListFromRows — group rollup', …)` block from Task 5. Add them one at a time, run, verify, commit at the end.

- [ ] **Step 1: Add test — cheapest member across retailers**

```typescript
it('picks the cheapest member across retailers for the group', () => {
  const list = buildShoppingListFromRows({
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [],
    checkedCanonicalIds: new Set(),
    ingredients: [
      ing({ canonicalId: 'pasta_penne', canonicalName: 'Penne', shoppingGroup: 'pasta', quantity: 1 }),
      ing({ canonicalId: 'pasta_rigatoni', canonicalName: 'Rigatoni', shoppingGroup: 'pasta', quantity: 1 }),
    ],
    deals: [
      deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', retailerName: 'Harris Teeter', salePrice: 2.99 }),
      deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', retailerName: 'Sprouts', salePrice: 1.49 }),
    ],
  });

  const sprouts = list.sections.find((s) => s.retailer === 'Sprouts');
  expect(sprouts, 'row should land under Sprouts (cheapest member)').toBeDefined();
  expect(sprouts!.items[0].cheapestMemberCanonicalId).toBe('pasta_rigatoni');
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 2: Add test — ungrouped canonical regression guard**

```typescript
it('produces one row per canonical when all shoppingGroups are null (regression)', () => {
  const list = buildShoppingListFromRows({
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [],
    checkedCanonicalIds: new Set(),
    ingredients: [
      ing({ canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', shoppingGroup: null, quantity: 2 }),
      ing({ canonicalId: 'yellow_onion', canonicalName: 'Yellow Onion', shoppingGroup: null, quantity: 1 }),
    ],
    deals: [
      deal({ canonicalId: 'chicken_breast', shoppingGroup: null, retailerName: 'Harris Teeter', salePrice: 3.99 }),
      deal({ canonicalId: 'yellow_onion', shoppingGroup: null, retailerName: 'Harris Teeter', salePrice: 0.99 }),
    ],
  });

  const ht = list.sections.find((s) => s.retailer === 'Harris Teeter');
  expect(ht?.items).toHaveLength(2);
  const ids = ht!.items.map((i) => i.groupKey).sort();
  expect(ids).toEqual(['chicken_breast', 'yellow_onion']);
  for (const i of ht!.items) {
    // For ungrouped rows, groupKey === canonicalId and displayName === canonicalName.
    expect(i.memberCanonicalIdsInUse).toEqual([i.groupKey]);
    expect(i.cheapestMemberCanonicalId).toBe(i.groupKey);
  }
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 3: Add test — single-member group**

```typescript
it('displays family name even when only one member of a group is used', () => {
  const list = buildShoppingListFromRows({
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [],
    checkedCanonicalIds: new Set(),
    ingredients: [
      ing({ canonicalId: 'pasta_penne', canonicalName: 'Penne', shoppingGroup: 'pasta', quantity: 1 }),
    ],
    deals: [
      deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: 1.99 }),
    ],
  });

  const ht = list.sections.find((s) => s.retailer === 'Harris Teeter');
  const row = ht!.items[0];
  expect(row.displayName).toBe('Pasta');
  expect(row.memberCanonicalIdsInUse).toEqual(['pasta_penne']);
  expect(row.usage).toHaveLength(1);
  expect(row.cheapestMemberDisplayName).toBe('Penne');
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 4: Add test — group with no on-sale deals**

```typescript
it('places a group with no on-sale deals into the Not on sale section using regular price', () => {
  const list = buildShoppingListFromRows({
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [],
    checkedCanonicalIds: new Set(),
    ingredients: [
      ing({ canonicalId: 'pasta_penne', canonicalName: 'Penne', shoppingGroup: 'pasta', quantity: 1 }),
      ing({ canonicalId: 'pasta_rigatoni', canonicalName: 'Rigatoni', shoppingGroup: 'pasta', quantity: 1 }),
    ],
    deals: [
      deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: null, regularPrice: 2.99 }),
      deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', salePrice: null, regularPrice: 2.49 }),
    ],
  });

  const nos = list.sections.find((s) => s.retailer === 'Not on sale');
  expect(nos).toBeDefined();
  const row = nos!.items[0];
  expect(row.regularPrice).toBe(2.49);
  expect(row.cheapestMemberCanonicalId).toBe('pasta_rigatoni');
  // Regular-price groups do not contribute to grandTotalOnSale; only grandTotalAll.
  expect(list.grandTotalOnSale).toBe(0);
  expect(list.grandTotalAll).toBeCloseTo(Math.ceil(2) * 2.49, 2);
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Add test — usage list content**

```typescript
it('records each meal + shape combination in the usage list', () => {
  const list = buildShoppingListFromRows({
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [],
    checkedCanonicalIds: new Set(),
    ingredients: [
      ing({ canonicalId: 'pasta_rigatoni', canonicalName: 'Rigatoni', shoppingGroup: 'pasta', quantity: 1, mealName: 'Rigatoni Bolognese', mealDay: 'Monday' }),
      ing({ canonicalId: 'pasta_penne', canonicalName: 'Penne', shoppingGroup: 'pasta', quantity: 1, mealName: 'Penne Vodka', mealDay: 'Wednesday' }),
    ],
    deals: [
      deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: 1.99 }),
      deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', salePrice: 2.49 }),
    ],
  });

  const ht = list.sections.find((s) => s.retailer === 'Harris Teeter');
  const row = ht!.items[0];
  expect(row.usage).toHaveLength(2);
  const days = row.usage.map((u) => u.mealDay).sort();
  expect(days).toEqual(['Monday', 'Wednesday']);
  const shapes = row.usage.map((u) => u.canonicalDisplayName).sort();
  expect(shapes).toEqual(['Penne', 'Rigatoni']);
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 6: Add test — isChecked semantics (all members checked)**

```typescript
it('marks a group as checked iff every member-in-use is in checkedCanonicalIds', () => {
  const base = {
    planId: 1,
    weekOf: '2026-08-03',
    pantryCanonicalIds: [] as readonly string[],
    ingredients: [
      ing({ canonicalId: 'pasta_penne', canonicalName: 'Penne', shoppingGroup: 'pasta', quantity: 1 }),
      ing({ canonicalId: 'pasta_rigatoni', canonicalName: 'Rigatoni', shoppingGroup: 'pasta', quantity: 1 }),
    ],
    deals: [
      deal({ canonicalId: 'pasta_penne', shoppingGroup: 'pasta', salePrice: 1.99 }),
      deal({ canonicalId: 'pasta_rigatoni', shoppingGroup: 'pasta', salePrice: 2.49 }),
    ],
  };

  const partial = buildShoppingListFromRows({ ...base, checkedCanonicalIds: new Set(['pasta_penne']) });
  const partialRow = partial.sections.find((s) => s.retailer === 'Harris Teeter')!.items[0];
  expect(partialRow.isChecked).toBe(false);

  const full = buildShoppingListFromRows({
    ...base,
    checkedCanonicalIds: new Set(['pasta_penne', 'pasta_rigatoni']),
  });
  const fullRow = full.sections.find((s) => s.retailer === 'Harris Teeter')!.items[0];
  expect(fullRow.isChecked).toBe(true);
});
```

Run: `npm test -- tests/meal-planner/shopping-list.test.ts`
Expected: PASS.

- [ ] **Step 7: Full test suite regression check**

Run: `npm test`
Expected: 177 (post-Task 3) + 6 (new) = 183 tests pass.

- [ ] **Step 8: Commit**

```bash
git add tests/meal-planner/shopping-list.test.ts
git commit -m "Shopping list: exhaustive group-rollup test coverage"
```

---

## Task 7: Wire `shopping_group`, meal name, and meal day through `buildShoppingList`

**Files:**
- Modify: `lib/meal-planner/shopping-list.ts` (the `buildShoppingList` orchestrator function)

- [ ] **Step 1: Update the DB queries to fetch new fields**

In `lib/meal-planner/shopping-list.ts`, find the `buildShoppingList` function. Replace the type declarations and the `Promise.all` block with:

```typescript
type MealRow = {
  id: number;
  day: string;
  name: string;
  meal_ingredients: Array<{
    canonical_ingredient_id: string;
    quantity: number | null;
    unit: string | null;
    canonical_ingredients: { name: string; shopping_group: string | null } | null;
  }>;
};
type DealRow = {
  sale_price: number | null;
  regular_price: number | null;
  retailer_skus: {
    canonical_ingredient_id: string | null;
    canonical_ingredients: { shopping_group: string | null } | null;
    retailers: { name: string };
  };
};

const [ingResult, dealResult, checkResult, pantryResult] = await Promise.all([
  supabase
    .from('meals')
    .select(
      `id, day, name,
       meal_ingredients (canonical_ingredient_id, quantity, unit,
         canonical_ingredients (name, shopping_group))`
    )
    .eq('meal_plan_id', planId),
  supabase
    .from('deals')
    .select(
      `sale_price, regular_price,
       retailer_skus!inner (canonical_ingredient_id,
         canonical_ingredients (shopping_group),
         retailers!inner (name))`
    )
    .eq('week_of', weekOf),
  supabase
    .from('shopping_list_checks')
    .select('canonical_ingredient_id')
    .eq('meal_plan_id', planId),
  supabase
    .from('pantry')
    .select('canonical_ingredient_id'),
]);
```

- [ ] **Step 2: Update the ingredient projection**

Replace the `const ingredients = ...` block with:

```typescript
const ingredients = ((ingRows ?? []) as unknown as MealRow[]).flatMap((meal) =>
  (meal.meal_ingredients ?? []).map((ing) => ({
    canonicalId: ing.canonical_ingredient_id,
    canonicalName: ing.canonical_ingredients?.name ?? ing.canonical_ingredient_id,
    shoppingGroup: ing.canonical_ingredients?.shopping_group ?? null,
    quantity: ing.quantity,
    unit: ing.unit,
    mealName: meal.name,
    mealDay: meal.day,
  }))
);
```

- [ ] **Step 3: Update the deals projection**

Replace the `const deals = ...` block with:

```typescript
const deals = ((dealRows ?? []) as unknown as DealRow[])
  .filter((r) => r.retailer_skus.canonical_ingredient_id !== null)
  .map((r) => ({
    canonicalId: r.retailer_skus.canonical_ingredient_id as string,
    shoppingGroup: r.retailer_skus.canonical_ingredients?.shopping_group ?? null,
    retailerName: r.retailer_skus.retailers.name,
    salePrice: r.sale_price,
    regularPrice: r.regular_price,
  }));
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors. No new errors.

- [ ] **Step 5: Run the meal-planner test suite**

Run: `npm test -- tests/meal-planner/`
Expected: all tests still pass. The orchestrator isn't unit-tested directly (mocks Supabase in integration tests), so this mostly validates that types line up.

- [ ] **Step 6: Commit**

```bash
git add lib/meal-planner/shopping-list.ts
git commit -m "buildShoppingList: pass shopping_group + meal name/day through"
```

---

## Task 8: Server action + client checkbox — group-aware toggle

**Files:**
- Modify: `app/plan/shopping-list/actions.ts`
- Modify: `app/plan/shopping-list/ShoppingItemCheckbox.tsx`
- Create: `tests/api/toggle-shopping-item.test.ts`

- [ ] **Step 1: Write the failing action tests**

Create `tests/api/toggle-shopping-item.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spies for shopping_list_checks (upsert / delete) and pantry (upsert).
const checksUpsertSpy = vi.fn(async () => ({ error: null }));
const checksDeleteCall = vi.fn(async () => ({ error: null }));
const pantryUpsertSpy = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'shopping_list_checks') {
        return {
          upsert: (rows: unknown) => checksUpsertSpy(rows as unknown),
          delete: () => ({
            eq: (_col: string, _v: unknown) => ({
              in: (_col2: string, ids: string[]) => checksDeleteCall(ids),
            }),
          }),
        };
      }
      if (table === 'pantry') {
        return {
          upsert: (row: unknown) => pantryUpsertSpy(row as unknown),
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { toggleShoppingItem } from '@/app/plan/shopping-list/actions';

beforeEach(() => {
  checksUpsertSpy.mockClear();
  checksDeleteCall.mockClear();
  pantryUpsertSpy.mockClear();
});

describe('toggleShoppingItem — group semantics', () => {
  it('check-on with two member ids inserts two check rows and two pantry rows', async () => {
    await toggleShoppingItem(1, ['pasta_penne', 'pasta_rigatoni'], true);
    expect(checksUpsertSpy).toHaveBeenCalledTimes(1);
    const rows = checksUpsertSpy.mock.calls[0][0] as Array<{
      meal_plan_id: number;
      canonical_ingredient_id: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.canonical_ingredient_id).sort()).toEqual(['pasta_penne', 'pasta_rigatoni']);

    expect(pantryUpsertSpy).toHaveBeenCalledTimes(2);
  });

  it('check-off deletes exactly the given member ids from checks, leaves pantry alone', async () => {
    await toggleShoppingItem(1, ['pasta_penne', 'pasta_rigatoni'], false);
    expect(checksDeleteCall).toHaveBeenCalledWith(['pasta_penne', 'pasta_rigatoni']);
    expect(pantryUpsertSpy).not.toHaveBeenCalled();
    expect(checksUpsertSpy).not.toHaveBeenCalled();
  });

  it('ungrouped canonical (single-member array) behaves identically to prior single-id behavior', async () => {
    await toggleShoppingItem(1, ['chicken_breast'], true);
    const rows = checksUpsertSpy.mock.calls[0][0] as unknown[];
    expect(rows).toHaveLength(1);
    expect(pantryUpsertSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/api/toggle-shopping-item.test.ts`
Expected: FAIL — current signature is `toggleShoppingItem(planId, canonicalId: string, ...)`.

- [ ] **Step 3: Rewrite the server action**

Replace the contents of `app/plan/shopping-list/actions.ts` with:

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function toggleShoppingItem(
  planId: number,
  memberCanonicalIds: readonly string[],
  nextChecked: boolean
): Promise<void> {
  if (memberCanonicalIds.length === 0) return;
  const supabase = getServerClient();

  if (nextChecked) {
    // 1. Persist one check row per member canonical.
    const checkRows = memberCanonicalIds.map((canonicalId) => ({
      meal_plan_id: planId,
      canonical_ingredient_id: canonicalId,
    }));
    const { error: checkErr } = await supabase
      .from('shopping_list_checks')
      .upsert(checkRows);
    if (checkErr) throw checkErr;

    // 2. Auto-add every member to pantry. Idempotent via UNIQUE(canonical_ingredient_id).
    for (const canonicalId of memberCanonicalIds) {
      const { error: pantryErr } = await supabase
        .from('pantry')
        .upsert(
          { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
          { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
        );
      if (pantryErr) throw pantryErr;
    }
  } else {
    // Uncheck: remove the N check rows in one query. Do NOT touch pantry
    // (matches prior behavior — unchecks are usually corrections).
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .in('canonical_ingredient_id', memberCanonicalIds as string[]);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
  revalidatePath('/pantry');
}
```

- [ ] **Step 4: Run action tests — verify pass**

Run: `npm test -- tests/api/toggle-shopping-item.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Update `ShoppingItemCheckbox` to pass member ids**

Replace `app/plan/shopping-list/ShoppingItemCheckbox.tsx` with:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { toggleShoppingItem } from './actions';

export function ShoppingItemCheckbox({
  planId,
  memberCanonicalIds,
  initialChecked,
  children,
}: {
  planId: number;
  memberCanonicalIds: readonly string[];
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
          if (pending) return;
          const next = e.target.checked;
          setChecked(next);
          startTransition(async () => {
            try {
              await toggleShoppingItem(planId, memberCanonicalIds, next);
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

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: still 9 errors (`page.tsx` will now flag `canonicalId` doesn't exist on `ShoppingListItem` — but that's the file we edit in Task 9. Read the error message; if it's ONLY about `page.tsx` and the props on `ShoppingItemCheckbox`, that's acceptable transient state. Note: if the count exceeds `9 + (however many page.tsx errors)`, stop and diagnose).

- [ ] **Step 7: Commit**

```bash
git add app/plan/shopping-list/actions.ts app/plan/shopping-list/ShoppingItemCheckbox.tsx tests/api/toggle-shopping-item.test.ts
git commit -m "toggleShoppingItem: accept memberCanonicalIds for group check-on/off"
```

---

## Task 9: `/plan/shopping-list` UI — render family name, cheapest, and usage sub-lines

**Files:**
- Modify: `app/plan/shopping-list/page.tsx`

- [ ] **Step 1: Update the render to use new item fields**

Replace `app/plan/shopping-list/page.tsx` with:

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';
import { buildShoppingList } from '@/lib/meal-planner/shopping-list';
import { ShoppingItemCheckbox } from './ShoppingItemCheckbox';

export const dynamic = 'force-dynamic';

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
    .select('id, week_of, pantry_canonical_ingredient_ids')
    .eq('week_of', weekOf)
    .maybeSingle();

  if (!planRow) {
    redirect('/plan');
  }

  const list = await buildShoppingList(planRow);

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6 flex items-center gap-4">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
        <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
          Pantry
        </Link>
        <Link href="/health" className="text-sm text-blue-600 hover:underline">
          Health
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
        <p className="text-gray-500">No items to buy for this week&apos;s plan.</p>
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
              {section.items.map((item) => {
                const qtyStr = qty(item.quantity, item.unit);
                // "used in" sub-line is only informative for actual groups
                // (multiple different members) — hide it for ungrouped rows.
                const showUsage =
                  item.memberCanonicalIdsInUse.length > 1 && item.usage.length > 0;
                // "cheapest: X" sub-line is only informative for actual groups.
                const showCheapest =
                  item.memberCanonicalIdsInUse.length > 1 &&
                  item.cheapestMemberDisplayName !== item.displayName;
                return (
                  <li key={item.groupKey} className="mb-2">
                    <ShoppingItemCheckbox
                      planId={list.planId}
                      memberCanonicalIds={item.memberCanonicalIdsInUse}
                      initialChecked={item.isChecked}
                    >
                      <span>{item.displayName}</span>
                      <span className="text-sm text-gray-500">
                        {qtyStr && ` · ${qtyStr}`}
                        {item.salePrice !== null && ` · ${fmt(item.salePrice)}`}
                        {item.salePrice === null && item.regularPrice !== null &&
                          ` · ${fmt(item.regularPrice)} (regular)`}
                        {item.salePrice === null && item.regularPrice === null && ' · —'}
                      </span>
                    </ShoppingItemCheckbox>
                    {showCheapest && (
                      <p className="ml-7 mt-0.5 text-xs text-gray-500">
                        cheapest: {item.cheapestMemberDisplayName}
                      </p>
                    )}
                    {showUsage && (
                      <p className="ml-7 text-xs text-gray-500">
                        used in:{' '}
                        {item.usage
                          .map((u) => `${u.mealDay}'s ${u.mealName} (${u.canonicalDisplayName})`)
                          .join(', ')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: back to 9 errors (the pre-existing ones). No new errors.

- [ ] **Step 3: Commit**

```bash
git add app/plan/shopping-list/page.tsx
git commit -m "Shopping list UI: render family name, cheapest, and usage sub-lines"
```

---

## Task 10: Full local verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: 183 (post-Task 6) + 3 (Task 8 action tests) = 186 tests pass across 26 files.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 9 errors — the pre-existing ones only.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds. In the route manifest, `/plan/shopping-list` still shows as `ƒ` Dynamic (size may change slightly).

- [ ] **Step 4: Dev smoke — generate a plan and inspect the shopping list**

Start dev server: `npm run dev`

In a browser, log in at `http://localhost:3000/login`, then:
1. Go to `/plan` and click Regenerate.
2. Wait for the plan to render.
3. Open `/plan/shopping-list`.

Look for:
- If the week's plan uses two or more pasta shapes, they appear as ONE "Pasta" row with combined quantity, a "cheapest: X" sub-line, and a "used in: Monday's Bolognese (Rigatoni), Wednesday's Vodka (Penne)" sub-line.
- Non-pasta ingredients render exactly as before (no sub-lines).
- Checking off the "Pasta" row: line-through applies immediately; refreshing keeps it checked; both member canonicals show up in the pantry (`/pantry`).
- Unchecking: line-through disappears immediately; refreshing keeps it unchecked. Pantry entries persist (per the "don't remove on uncheck" rule).

Stop the dev server.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin week-2b-pasta-family-grouping
```

---

## Task 11: PR, Vercel verify, merge, prod verify

**Files:** none (deployment verification)

- [ ] **Step 1: Open a PR**

```bash
gh pr create --title "Week 2b — Pasta family grouping" --body "$(cat <<'EOF'
## Summary
- New nullable `shopping_group` column on `canonical_ingredients` (migration `0004`)
- All 6 Italian pasta shapes get `shopping_group='pasta'` — noodles, lasagna, and sauce stay ungrouped
- Shopping list rolls up group members into one row per family with "cheapest: X" and "used in: …" sub-lines
- Server action accepts `memberCanonicalIds: string[]` so a family check-on inserts N `shopping_list_checks` rows and adds all members to `pantry`
- Recipe copy is unchanged — meals still say "Rigatoni Bolognese"

## Test plan
- [ ] Preview build succeeds
- [ ] `/plan/shopping-list` shows one Pasta row when a week uses ≥ 2 pasta shapes
- [ ] Non-pasta ingredients render exactly as before (no sub-lines, one row per canonical)
- [ ] Checking Pasta persists (both members appear in `/pantry` after refresh)
- [ ] Unchecking Pasta persists (line-through removed; pantry members stay)
- [ ] Existing single-canonical items (e.g., chicken_breast) still work byte-identically

## Spec
`docs/superpowers/specs/2026-08-03-week-2b-pasta-family-grouping-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for Vercel preview build**

```bash
until vercel inspect "$(vercel ls grocery-planner 2>&1 | grep Preview | head -1 | awk '{print $4}')" 2>&1 | grep -qE "status.*(Ready|Error)"; do sleep 6; done
vercel ls grocery-planner 2>&1 | head -3
```

Expected: newest Preview shows `● Ready`.

- [ ] **Step 3: Smoke test the preview**

```bash
PREVIEW_URL=$(vercel ls grocery-planner 2>&1 | grep Preview | head -1 | awk '{print $4}')
curl -sI "$PREVIEW_URL/plan/shopping-list"
```

Expected: 307 → `/login` (proves middleware still guards the page). Full UI verification requires a browser login on the preview URL.

- [ ] **Step 4: Merge the PR**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 5: Wait for production build**

```bash
until vercel inspect "$(vercel ls grocery-planner 2>&1 | grep Production | head -1 | awk '{print $4}')" 2>&1 | grep -qE "status.*(Ready|Error)"; do sleep 6; done
```

Expected: newest Production shows `● Ready`.

- [ ] **Step 6: Production spot-check**

Log in to `https://grocery-planner-omega.vercel.app`, go to `/plan/shopping-list`. Expected:
- If the current plan uses ≥ 2 pasta shapes, exactly ONE "Pasta" row with rolled-up qty + sub-lines.
- Otherwise, layout unchanged from before this deploy.
- Check-off + refresh works end-to-end.

If the plan doesn't currently include pasta variety, click Regenerate on `/plan` to try for a fresh selection, then re-verify.

---

## Rollback

- **Bad code:** revert the merge commit via a revert PR:
  ```bash
  git revert -m 1 <merge-sha>
  git push origin main
  ```
- **Bad seed data (wrong `shopping_group` values):** re-edit `lib/canonical-ingredients/seed-data.ts` and re-run `npm run seed` — `upsert(..., { onConflict: 'id' })` overwrites.
- **Bad migration:** additive column, safe to leave in place after a code revert. Extreme case: `ALTER TABLE canonical_ingredients DROP COLUMN shopping_group;` restores prior schema (coordinate with a matching code revert of Task 4 so the seed loader doesn't fail on the unknown column).

The migration + seed changes are backward-compatible with the pre-Week-2b code (which never reads `shopping_group`), so a pure code revert without touching the DB is safe.

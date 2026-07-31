# Week 5a — Pantry State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/pantry` page (staples grid + current-pantry list + search-add) and wire an auto-add hook into the existing shopping-list check-off Server Action. Extend `buildShoppingList` to live-filter against the current `pantry` table on top of the existing snapshot.

**Architecture:** Reuse the existing `pantry` table (no schema changes). New `lib/pantry/{queries,actions,staples}.ts` modules. New `/pantry` route with one Server Component page and three focused Client Components sharing a `Set<string>` of pantry IDs via a client wrapper. Modify `lib/meal-planner/shopping-list.ts` to union the snapshot with a live pantry query (4th parallel fetch) before calling the unchanged pure builder. Modify `app/plan/shopping-list/actions.ts` to also insert into `pantry` on check.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres), Vitest, Tailwind, Vercel.

**Spec:** `docs/superpowers/specs/2026-07-31-week-5a-pantry-design.md`

---

## Preflight

- [ ] **Step 1: Create a feature branch off main**

```bash
cd ~/Documents/Coding/grocery-planner
git checkout main
git pull
git checkout -b week-5a-pantry
```

- [ ] **Step 2: Confirm you can run tests and typecheck locally**

```bash
npm test -- --run tests/meal-planner/shopping-list.test.ts
npx tsc --noEmit
```

Expected: `shopping-list.test.ts` passes (13 tests). `tsc` may report the pre-existing errors under `tests/ingestion/harris-teeter/*` and `tests/normalization/runner.test.ts` — those are not ours; ignore them. Any error in `app/pantry/`, `lib/pantry/`, `lib/meal-planner/`, or `tests/pantry/` is ours to fix.

---

## Task 1: Staples list + guard test

**Files:**
- Create: `lib/pantry/staples.ts`
- Create: `tests/pantry/staples.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/pantry/staples.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { STAPLE_CANONICAL_IDS } from '@/lib/pantry/staples';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

describe('STAPLE_CANONICAL_IDS', () => {
  it('has exactly 15 entries', () => {
    expect(STAPLE_CANONICAL_IDS).toHaveLength(15);
  });

  it('has no duplicates', () => {
    expect(new Set(STAPLE_CANONICAL_IDS).size).toBe(STAPLE_CANONICAL_IDS.length);
  });

  it('every entry exists in the canonical-ingredients seed', () => {
    const seedIds = new Set(CANONICAL_INGREDIENTS.map((c) => c.id));
    for (const id of STAPLE_CANONICAL_IDS) {
      expect(seedIds.has(id), `staple '${id}' missing from seed`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/pantry/staples.test.ts`
Expected: FAIL — cannot resolve `@/lib/pantry/staples`.

- [ ] **Step 3: Create the staples module**

Create `lib/pantry/staples.ts`:

```typescript
// Fixed order — matches the display grid on /pantry.
// Every ID must exist in lib/canonical-ingredients/seed-data.ts
// (guarded by tests/pantry/staples.test.ts).
export const STAPLE_CANONICAL_IDS: readonly string[] = [
  'olive_oil',
  'salt_kosher',
  'pepper_black',
  'yellow_onion',
  'garlic',
  'flour_ap',
  'sugar_white',
  'rice_white_long',
  'pasta_spaghetti',
  'tomato_crushed_canned',
  'soy_sauce',
  'egg_large',
  'milk_whole',
  'butter_unsalted',
  'coffee_ground',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/pantry/staples.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pantry/staples.ts tests/pantry/staples.test.ts
git commit -m "Pantry: hardcoded staples list + seed-drift guard test"
```

---

## Task 2: Pantry queries module

**Files:**
- Create: `lib/pantry/queries.ts`

No test — this is a thin Supabase read wrapper, same rationale as existing `buildShoppingList`'s DB fetches.

- [ ] **Step 1: Create the queries module**

Create `lib/pantry/queries.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';

export type PantryItem = {
  canonicalId: string;
  name: string;
};

export async function listPantry(): Promise<PantryItem[]> {
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('pantry')
    .select('canonical_ingredient_id, canonical_ingredients (name)');
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    canonical_ingredient_id: string;
    canonical_ingredients: { name: string } | null;
  }>;

  return rows
    .filter((r) => r.canonical_ingredients !== null)
    .map((r) => ({
      canonicalId: r.canonical_ingredient_id,
      name: (r.canonical_ingredients as { name: string }).name,
    }));
}

export async function listPantryIds(): Promise<string[]> {
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('pantry')
    .select('canonical_ingredient_id');
  if (error) throw error;
  return ((data ?? []) as Array<{ canonical_ingredient_id: string }>).map(
    (r) => r.canonical_ingredient_id
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors in `lib/pantry/`.

- [ ] **Step 3: Commit**

```bash
git add lib/pantry/queries.ts
git commit -m "Pantry: listPantry and listPantryIds queries"
```

---

## Task 3: Pantry Server Actions

**Files:**
- Create: `lib/pantry/actions.ts`

- [ ] **Step 1: Create the actions module**

Create `lib/pantry/actions.ts`:

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { getServerClient } from '@/lib/db/client';

export async function addToPantry(canonicalId: string): Promise<void> {
  const supabase = getServerClient();
  // Insert is idempotent thanks to the UNIQUE constraint on canonical_ingredient_id.
  const { error } = await supabase
    .from('pantry')
    .upsert(
      { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
      { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
    );
  if (error) throw error;
  revalidatePath('/pantry');
  revalidatePath('/plan/shopping-list');
}

export async function removeFromPantry(canonicalId: string): Promise<void> {
  const supabase = getServerClient();
  const { error } = await supabase
    .from('pantry')
    .delete()
    .eq('canonical_ingredient_id', canonicalId);
  if (error) throw error;
  revalidatePath('/pantry');
  revalidatePath('/plan/shopping-list');
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/pantry/actions.ts
git commit -m "Pantry: addToPantry and removeFromPantry Server Actions"
```

---

## Task 4: Extend shopping-list to live-filter against current pantry

**Files:**
- Modify: `lib/meal-planner/shopping-list.ts:167-252` (the `buildShoppingList` orchestrator)
- Modify: `tests/meal-planner/shopping-list.test.ts` (append new cases)

Pure builder `buildShoppingListFromRows` is unchanged — it already treats `pantryCanonicalIds` as an exclusion set. We're only changing the orchestrator to fetch and union with the live pantry table.

- [ ] **Step 1: Write the failing tests**

Append these three cases to `tests/meal-planner/shopping-list.test.ts` inside the existing `describe('buildShoppingListFromRows', ...)` block (before the closing `});`):

```typescript
  it('excludes items whose canonical_id is in the live pantry union (not in snapshot)', () => {
    const result = buildShoppingListFromRows(
      inputs({
        // Simulates the orchestrator having unioned snapshot + live pantry.
        pantryCanonicalIds: ['garlic'],
        ingredients: [
          { canonicalId: 'garlic', canonicalName: 'Garlic', quantity: 1, unit: 'head' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const canonicals = result.sections.flatMap((s) => s.items.map((i) => i.canonicalId));
    expect(canonicals).toEqual(['chicken_breast']);
  });

  it('deduplicates when the same canonical is in both snapshot and live pantry (no double effect)', () => {
    // Real orchestrator unions the two lists before passing them in. A canonical
    // appearing twice in the input should filter out exactly once — no crash, no double-count.
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil', 'olive_oil'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', quantity: 2, unit: 'tbsp' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const canonicals = result.sections.flatMap((s) => s.items.map((i) => i.canonicalId));
    expect(canonicals).toEqual(['chicken_breast']);
  });

  it('handles disjoint snapshot and live pantry canonicals — both filtered, third ingredient survives', () => {
    // Simulates snapshot exclude=[A], live pantry exclude=[B] merged by orchestrator into [A, B].
    const result = buildShoppingListFromRows(
      inputs({
        pantryCanonicalIds: ['olive_oil', 'garlic'],
        ingredients: [
          { canonicalId: 'olive_oil', canonicalName: 'Olive Oil', quantity: 2, unit: 'tbsp' },
          { canonicalId: 'garlic', canonicalName: 'Garlic', quantity: 1, unit: 'head' },
          { canonicalId: 'chicken_breast', canonicalName: 'Chicken Breast', quantity: 1, unit: 'lb' },
        ],
      })
    );
    const canonicals = result.sections.flatMap((s) => s.items.map((i) => i.canonicalId));
    expect(canonicals).toEqual(['chicken_breast']);
  });
```

- [ ] **Step 2: Run tests to verify all three pass immediately**

Run: `npm test -- --run tests/meal-planner/shopping-list.test.ts`
Expected: PASS — the pure builder already handles all three cases correctly (the `pantry` `Set` in `buildShoppingListFromRows` naturally dedupes). These tests are **regression guards** locking in the current behavior so the upcoming orchestrator change can't quietly break it.

- [ ] **Step 3: Modify the orchestrator to fetch and union live pantry**

Edit `lib/meal-planner/shopping-list.ts`. Change the `buildShoppingList` function (starts around line 167). Replace the `Promise.all` block and the return call with the following. Full replacement of the function body:

```typescript
export async function buildShoppingList(plan: PlanRow): Promise<ShoppingList> {
  const supabase = getServerClient();
  const planId = plan.id;
  const weekOf = plan.week_of;

  type MealRow = {
    id: number;
    meal_ingredients: Array<{
      canonical_ingredient_id: string;
      quantity: number | null;
      unit: string | null;
      canonical_ingredients: { name: string } | null;
    }>;
  };
  type DealRow = {
    sale_price: number | null;
    regular_price: number | null;
    retailer_skus: {
      canonical_ingredient_id: string | null;
      retailers: { name: string };
    };
  };

  // 2–5. Ingredients, deals, checks, and live pantry are all independent — fetch in parallel.
  const [ingResult, dealResult, checkResult, pantryResult] = await Promise.all([
    supabase
      .from('meals')
      .select(
        `id,
         meal_ingredients (canonical_ingredient_id, quantity, unit,
           canonical_ingredients (name))`
      )
      .eq('meal_plan_id', planId),
    supabase
      .from('deals')
      .select(
        `sale_price, regular_price,
         retailer_skus!inner (canonical_ingredient_id,
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
  if (ingResult.error) throw ingResult.error;
  if (dealResult.error) throw dealResult.error;
  if (checkResult.error) throw checkResult.error;
  if (pantryResult.error) throw pantryResult.error;
  const ingRows = ingResult.data;
  const dealRows = dealResult.data;
  const checkRows = checkResult.data;
  const pantryRows = pantryResult.data;

  const ingredients = ((ingRows ?? []) as unknown as MealRow[]).flatMap((meal) =>
    (meal.meal_ingredients ?? []).map((ing) => ({
      canonicalId: ing.canonical_ingredient_id,
      canonicalName: ing.canonical_ingredients?.name ?? ing.canonical_ingredient_id,
      quantity: ing.quantity,
      unit: ing.unit,
    }))
  );

  const deals = ((dealRows ?? []) as unknown as DealRow[])
    .filter((r) => r.retailer_skus.canonical_ingredient_id !== null)
    .map((r) => ({
      canonicalId: r.retailer_skus.canonical_ingredient_id as string,
      retailerName: r.retailer_skus.retailers.name,
      salePrice: r.sale_price,
      regularPrice: r.regular_price,
    }));

  const checkedCanonicalIds = new Set(
    ((checkRows ?? []) as Array<{ canonical_ingredient_id: string }>).map(
      (r) => r.canonical_ingredient_id
    )
  );

  // Union the snapshot (what Haiku saw at plan-generation time) with the live
  // pantry (anything the user has added since). The pure builder filters ingredients
  // whose canonical is in this set.
  const livePantryIds = ((pantryRows ?? []) as Array<{ canonical_ingredient_id: string }>).map(
    (r) => r.canonical_ingredient_id
  );
  const pantryCanonicalIds = Array.from(
    new Set<string>([...(plan.pantry_canonical_ingredient_ids ?? []), ...livePantryIds])
  );

  return buildShoppingListFromRows({
    planId,
    weekOf,
    pantryCanonicalIds,
    ingredients,
    deals,
    checkedCanonicalIds,
  });
}
```

- [ ] **Step 4: Run the shopping-list tests again to confirm no regression**

Run: `npm test -- --run tests/meal-planner/shopping-list.test.ts`
Expected: PASS (16 tests — 13 existing + 3 new).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/meal-planner/shopping-list.ts tests/meal-planner/shopping-list.test.ts
git commit -m "Shopping list: union live pantry into exclusion set"
```

---

## Task 5: Auto-add to pantry on shopping-list check

**Files:**
- Modify: `app/plan/shopping-list/actions.ts`

- [ ] **Step 1: Update `toggleShoppingItem` to also insert into pantry on check**

Replace the contents of `app/plan/shopping-list/actions.ts` with:

```typescript
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
    // 1. Persist the check.
    const { error: checkErr } = await supabase
      .from('shopping_list_checks')
      .upsert({ meal_plan_id: planId, canonical_ingredient_id: canonicalId });
    if (checkErr) throw checkErr;

    // 2. Auto-add to pantry. Idempotent thanks to UNIQUE(canonical_ingredient_id).
    //    From here on, the live-pantry filter in buildShoppingList drops the row
    //    from the visible list — the check state on this row becomes moot.
    const { error: pantryErr } = await supabase
      .from('pantry')
      .upsert(
        { canonical_ingredient_id: canonicalId, quantity: null, unit: null },
        { onConflict: 'canonical_ingredient_id', ignoreDuplicates: true }
      );
    if (pantryErr) throw pantryErr;
  } else {
    // Uncheck: remove the check row only. Do NOT auto-remove from pantry
    // (unchecks are usually corrections, not "I ate it already").
    const { error } = await supabase
      .from('shopping_list_checks')
      .delete()
      .eq('meal_plan_id', planId)
      .eq('canonical_ingredient_id', canonicalId);
    if (error) throw error;
  }
  revalidatePath('/plan/shopping-list');
  revalidatePath('/pantry');
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/plan/shopping-list/actions.ts
git commit -m "Shopping list: auto-add to pantry on check-off"
```

---

## Task 6: `/pantry` route — server data loader + client wrapper

**Files:**
- Create: `app/pantry/page.tsx`
- Create: `app/pantry/pantry-page.tsx`

- [ ] **Step 1: Create the Server Component**

Create `app/pantry/page.tsx`:

```typescript
import Link from 'next/link';
import { getServerClient } from '@/lib/db/client';
import { listPantry } from '@/lib/pantry/queries';
import { PantryPage } from './pantry-page';

export const dynamic = 'force-dynamic';

type CanonicalRow = { id: string; name: string };

export default async function PantryRoute() {
  const supabase = getServerClient();

  const [pantry, canonicalsResult] = await Promise.all([
    listPantry(),
    supabase
      .from('canonical_ingredients')
      .select('id, name')
      .order('name'),
  ]);
  if (canonicalsResult.error) throw canonicalsResult.error;
  const canonicals = (canonicalsResult.data ?? []) as CanonicalRow[];

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Pantry</h1>
        <p className="text-sm text-gray-500">
          Anything here gets skipped in your shopping list.
        </p>
      </header>

      <PantryPage initialPantry={pantry} allCanonicals={canonicals} />
    </main>
  );
}
```

- [ ] **Step 2: Create the client wrapper**

Create `app/pantry/pantry-page.tsx`:

```typescript
'use client';

import { useCallback, useMemo, useState } from 'react';
import type { PantryItem } from '@/lib/pantry/queries';
import { addToPantry, removeFromPantry } from '@/lib/pantry/actions';
import { StaplesGrid } from './staples-grid';
import { PantryList } from './pantry-list';
import { AddIngredient } from './add-ingredient';

export type Canonical = { id: string; name: string };

export function PantryPage({
  initialPantry,
  allCanonicals,
}: {
  initialPantry: PantryItem[];
  allCanonicals: Canonical[];
}) {
  // Single source of truth for what's currently in the pantry.
  const [items, setItems] = useState<PantryItem[]>(initialPantry);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const idSet = useMemo(() => new Set(items.map((i) => i.canonicalId)), [items]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCanonicals) m.set(c.id, c.name);
    return m;
  }, [allCanonicals]);

  const add = useCallback(
    async (canonicalId: string) => {
      if (pending.has(canonicalId)) return;
      if (idSet.has(canonicalId)) return; // already in pantry — no-op
      const name = nameById.get(canonicalId);
      if (!name) return; // unknown canonical — bail
      const optimistic = { canonicalId, name };
      setItems((prev) => [...prev, optimistic]);
      setPending((prev) => new Set(prev).add(canonicalId));
      setError(null);
      try {
        await addToPantry(canonicalId);
      } catch {
        setItems((prev) => prev.filter((i) => i.canonicalId !== canonicalId));
        setError('Could not update pantry — try again');
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(canonicalId);
          return next;
        });
      }
    },
    [idSet, nameById, pending]
  );

  const remove = useCallback(
    async (canonicalId: string) => {
      if (pending.has(canonicalId)) return;
      if (!idSet.has(canonicalId)) return; // not present — no-op
      const removed = items.find((i) => i.canonicalId === canonicalId);
      setItems((prev) => prev.filter((i) => i.canonicalId !== canonicalId));
      setPending((prev) => new Set(prev).add(canonicalId));
      setError(null);
      try {
        await removeFromPantry(canonicalId);
      } catch {
        if (removed) setItems((prev) => [...prev, removed]);
        setError('Could not update pantry — try again');
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(canonicalId);
          return next;
        });
      }
    },
    [idSet, items, pending]
  );

  return (
    <div className="space-y-8">
      <StaplesGrid idSet={idSet} nameById={nameById} pending={pending} onAdd={add} onRemove={remove} />
      <PantryList items={items} pending={pending} onRemove={remove} />
      <AddIngredient allCanonicals={allCanonicals} idSet={idSet} onAdd={add} />
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck (will fail on missing child components — expected)**

Run: `npx tsc --noEmit`
Expected: errors for missing modules `./staples-grid`, `./pantry-list`, `./add-ingredient`. That's fine — we build them next.

- [ ] **Step 4: Commit (partial — with intentionally-broken imports; skip pre-commit typecheck if any)**

Skip this commit — it would leave the tree broken. Instead, continue to Tasks 7–9 without committing, then commit them all together at Task 9.

---

## Task 7: Staples grid client component

**Files:**
- Create: `app/pantry/staples-grid.tsx`

- [ ] **Step 1: Create the component**

Create `app/pantry/staples-grid.tsx`:

```typescript
'use client';

import { STAPLE_CANONICAL_IDS } from '@/lib/pantry/staples';

export function StaplesGrid({
  idSet,
  nameById,
  pending,
  onAdd,
  onRemove,
}: {
  idSet: Set<string>;
  nameById: Map<string, string>;
  pending: Set<string>;
  onAdd: (canonicalId: string) => Promise<void>;
  onRemove: (canonicalId: string) => Promise<void>;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Staples
      </h2>
      <div className="flex flex-wrap gap-2">
        {STAPLE_CANONICAL_IDS.map((id) => {
          const active = idSet.has(id);
          const isPending = pending.has(id);
          const label = nameById.get(id) ?? id;
          return (
            <button
              key={id}
              type="button"
              disabled={isPending}
              onClick={() => (active ? onRemove(id) : onAdd(id))}
              className={
                'px-3 py-1.5 rounded-full text-sm border transition-colors ' +
                (active
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50') +
                (isPending ? ' opacity-60 cursor-wait' : '')
              }
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

---

## Task 8: Current-pantry list component

**Files:**
- Create: `app/pantry/pantry-list.tsx`

- [ ] **Step 1: Create the component**

Create `app/pantry/pantry-list.tsx`:

```typescript
'use client';

import type { PantryItem } from '@/lib/pantry/queries';

export function PantryList({
  items,
  pending,
  onRemove,
}: {
  items: PantryItem[];
  pending: Set<string>;
  onRemove: (canonicalId: string) => Promise<void>;
}) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        In your pantry
      </h2>
      <ul className="divide-y divide-gray-200">
        {sorted.map((item) => {
          const isPending = pending.has(item.canonicalId);
          return (
            <li
              key={item.canonicalId}
              className="flex items-center justify-between py-2"
            >
              <span>{item.name}</span>
              <button
                type="button"
                disabled={isPending}
                onClick={() => onRemove(item.canonicalId)}
                className={
                  'text-gray-400 hover:text-red-600 text-lg leading-none w-8 h-8 flex items-center justify-center rounded ' +
                  (isPending ? 'opacity-60 cursor-wait' : '')
                }
                aria-label={`Remove ${item.name} from pantry`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

---

## Task 9: Add-ingredient autocomplete + commit the /pantry page

**Files:**
- Create: `app/pantry/add-ingredient.tsx`

- [ ] **Step 1: Create the autocomplete component**

Create `app/pantry/add-ingredient.tsx`:

```typescript
'use client';

import { useMemo, useState } from 'react';
import type { Canonical } from './pantry-page';

export function AddIngredient({
  allCanonicals,
  idSet,
  onAdd,
}: {
  allCanonicals: Canonical[];
  idSet: Set<string>;
  onAdd: (canonicalId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allCanonicals
      .filter((c) => !idSet.has(c.id) && c.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, allCanonicals, idSet]);

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Add ingredient
      </h2>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to search (e.g. cinnamon)"
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {matches.length > 0 && (
        <ul className="mt-2 border border-gray-200 rounded divide-y divide-gray-200">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={async () => {
                  await onAdd(c.id);
                  setQuery('');
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck the whole `/pantry` route**

Run: `npx tsc --noEmit`
Expected: no new errors under `app/pantry/` or `lib/pantry/`.

- [ ] **Step 3: Commit the full `/pantry` route as one atomic change**

```bash
git add app/pantry/page.tsx app/pantry/pantry-page.tsx app/pantry/staples-grid.tsx app/pantry/pantry-list.tsx app/pantry/add-ingredient.tsx
git commit -m "Pantry: /pantry route with staples grid, current list, and search-add"
```

---

## Task 10: Header link on `/plan/shopping-list`

**Files:**
- Modify: `app/plan/shopping-list/page.tsx:37-41` (the "Back to plan" nav block)

- [ ] **Step 1: Add a Pantry link next to the "Back to plan" link**

In `app/plan/shopping-list/page.tsx`, replace the existing `<div className="mb-6">…</div>` block (lines 37–41) with:

```typescript
      <div className="mb-6 flex items-center justify-between">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
        <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
          Pantry →
        </Link>
      </div>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/plan/shopping-list/page.tsx
git commit -m "Shopping list: add Pantry link in header"
```

---

## Task 11: Full local verification

- [ ] **Step 1: Run the full Vitest suite**

Run: `npm test -- --run`
Expected: all previously-passing tests still pass, plus the 3 new staple tests and 3 new shopping-list tests.

- [ ] **Step 2: Typecheck the whole app**

Run: `npx tsc --noEmit`
Expected: only the pre-existing errors under `tests/ingestion/harris-teeter/*` and `tests/normalization/runner.test.ts`. Nothing in `app/`, `lib/`, or `tests/pantry/`.

- [ ] **Step 3: Start the dev server**

Run: `npm run dev`
Expected: server up on `http://localhost:3000`.

- [ ] **Step 4: Manual smoke test — golden path**

In a browser, logged in via `SHARED_PASSWORD`:

1. Go to `/pantry`. Empty pantry list section is hidden; all 15 staple chips are inactive (white background).
2. Tap the "Olive Oil" chip. Chip flips to green (activated). A "Olive Oil" row appears in the middle section.
3. Go to `/plan/shopping-list`. If olive oil was on the list, its row is now gone.
4. Back on `/plan/shopping-list`, find an item that maps to a staple (e.g. Eggs). Check the box. Row disappears from the list.
5. Go to `/pantry`. Eggs chip is now green **and** appears in the middle list.
6. Type `cin` in the search box. See "Ground Cinnamon" in the suggestions. Click it. Cinnamon appears in the middle list; search input clears.
7. Click the `×` next to Ground Cinnamon. Row disappears from the middle list. Staple chips unchanged.

- [ ] **Step 5: Manual smoke test — regenerate path**

1. On `/plan`, click Regenerate → confirm. Wait for the new plan.
2. Go to `/plan/shopping-list`. The new list excludes olive oil and eggs (both currently in pantry from the golden path).
3. Verify no crash and no phantom "Ground Cinnamon" row (since we removed it).

- [ ] **Step 6: Manual smoke test — error handling (optional)**

Simulate a Supabase outage by killing your network / stopping the local Supabase proxy if you have one. Tap a chip. Expected: chip flips back, red inline error appears under the widget. Restore network — subsequent taps work.

Nothing to commit for verification; if any step fails, fix it and add a follow-up task above.

---

## Task 12: Push and open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin week-5a-pantry
```

- [ ] **Step 2: Open the PR via `gh`**

```bash
gh pr create --title "Week 5a — Pantry state" --body "$(cat <<'EOF'
## Summary
- New `/pantry` page: staples grid (15 hardcoded canonicals) + current-pantry list + search-add over all canonicals.
- Shopping-list check-off now auto-adds to pantry (no auto-remove on uncheck).
- `buildShoppingList` now unions the meal-plan pantry snapshot with the live `pantry` table, so pantry updates take effect on the current week's list without invalidating the plan.

## Test plan
- [x] `npm test -- --run` green (3 new staple tests, 3 new shopping-list tests).
- [x] `npx tsc --noEmit` — no new errors.
- [x] Manual smoke test in dev: chip toggles, current list add/remove, search-add, shopping-list check-off auto-adds and drops the row, Regenerate honors current pantry.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for Vercel preview + confirm smoke test on the preview URL**

Wait for the Vercel preview deploy to reach "Ready" (usually ~1 minute). Repeat Task 11 steps 4–5 against the preview URL. If green, merge.

- [ ] **Step 4: Merge and clean up**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull
```

Done. `main` is now week-5a-complete; the app auto-deploys to production on push.

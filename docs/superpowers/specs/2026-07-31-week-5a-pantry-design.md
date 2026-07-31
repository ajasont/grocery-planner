# Week 5a — Pantry State — Design

**Date:** 2026-07-31
**Status:** Design approved, ready for implementation plan
**Related:** builds on `2026-07-30-shopping-list-design.md` (shopping-list snapshot semantics)

## Goal

Add a `/pantry` page and an auto-add-on-shopping-list-check hook so the user can tell the app which staples they already have. Pantry contents affect the meal-planner input (already wired) *and* live-filter the current week's shopping list, without invalidating the plan Haiku generated.

## Non-goals (5a)

- Quantity or unit UI (schema keeps the columns; UI writes them as `null`).
- Vercel Cron weekly refresh (deferred to 5b).
- `/admin/health` dashboard (deferred to 5c).
- Meal ratings (deferred to 5d).
- Purchase history or "when did I add this?" timeline.
- Undo of an auto-add-on-check (user removes from `/pantry` manually).
- Categorization or aisle grouping in the pantry UI.

## User flow

1. From `/plan/shopping-list`, user taps a "Pantry" link in the header → `/pantry`.
2. Top of `/pantry`: a grid of ~15 staple chips (olive oil, salt, eggs, milk, butter, rice, pasta, canned tomatoes, garlic, yellow onion, flour, sugar, soy sauce, black pepper, coffee). Each chip is "activated" if that canonical is in the pantry. Tap toggles add/remove.
3. Middle: a list of everything currently in the pantry with an "×" button per row. Hidden when empty.
4. Bottom: a search-autocomplete field ("add ingredient") backed by all ~200 canonicals. Selecting a result adds it.
5. Back on `/plan/shopping-list`: any canonical in the pantry table is filtered out of the visible list. Checking an item's checkbox auto-adds it to the pantry, which drops the row on the next revalidation.
6. On `/plan` → Regenerate: the new plan snapshots the *current* pantry into `meal_plans.pantry_canonical_ingredient_ids`. Prior week's snapshot becomes irrelevant to the new list.

## Product decisions (locked)

| Decision | Choice |
|---|---|
| Snapshot vs. live pantry | Hybrid — snapshot preserved for meal-planner correctness; shopping-list view live-filters against current `pantry` too |
| Auto-add on shopping-list check | Yes; **no** auto-remove on uncheck (unchecks are usually corrections) |
| Pantry UI shape | Staples grid (top) + current-pantry list (middle) + search-add (bottom) |
| Quantity/unit UX | Presence-only; write `null` to schema columns |
| Staples list | 15 hardcoded canonical IDs, guarded by a Vitest against seed drift |
| Navigation entry point | Header link on `/plan/shopping-list` (skip global nav) |
| Regenerate semantics | Unchanged — new `meal_plans` row cascades old checks + old snapshot |

## Architecture

### Data model

**No schema changes.** Reuse the existing `pantry` table from `0001_initial_schema.sql`:

```
pantry (id serial pk, canonical_ingredient_id text UNIQUE FK, quantity numeric, unit text, updated_at)
```

- `quantity` and `unit` are written as `null` for every row.
- `UNIQUE(canonical_ingredient_id)` makes `INSERT ... ON CONFLICT DO NOTHING` the natural idempotent add.
- `meal_plans.pantry_canonical_ingredient_ids` (added in `0002_shopping_list.sql`) is untouched — it stays the snapshot of what Haiku saw.

### New modules

| Path | Purpose |
|---|---|
| `lib/pantry/queries.ts` | `listPantry()` → `{ canonicalId, name }[]` |
| `lib/pantry/actions.ts` | Server Actions `addToPantry(canonicalId)`, `removeFromPantry(canonicalId)`; each calls `revalidatePath('/pantry')` and `revalidatePath('/plan/shopping-list')` |
| `lib/pantry/staples.ts` | `STAPLE_CANONICAL_IDS: readonly string[]` — 15 IDs |
| `app/pantry/page.tsx` | Server Component: fetches current pantry + full canonicals list; renders three sections |
| `app/pantry/pantry-page.tsx` | Client wrapper holding the shared pantry `Set<string>` so widgets stay in sync during optimistic updates |
| `app/pantry/staples-grid.tsx` | Client: staple chips, tap toggles add/remove |
| `app/pantry/pantry-list.tsx` | Client: current-pantry rows with × (optimistic remove) |
| `app/pantry/add-ingredient.tsx` | Client: type-ahead over preloaded canonicals; select-to-add |

### Modified modules

| Path | Change |
|---|---|
| `lib/meal-planner/shopping-list.ts` | Add a 4th parallel query for `pantry` rows; union those IDs with `plan.pantry_canonical_ingredient_ids` before calling `buildShoppingListFromRows`. Pure builder is unchanged. |
| `app/plan/shopping-list/actions.ts` | Existing check-off Server Action: when `checked=true`, additionally call the pantry insert (idempotent). Uncheck path unchanged. |
| `app/plan/shopping-list/page.tsx` (header) | Add `<Link href="/pantry">Pantry</Link>` next to the existing controls. |

### Staples list

Fifteen IDs, all present in `lib/canonical-ingredients/seed-data.ts`:

```
olive_oil, salt_kosher, pepper_black, yellow_onion, garlic,
flour_ap, sugar_white, rice_white_long, pasta_spaghetti, tomato_crushed_canned,
soy_sauce, egg_large, milk_whole, butter_unsalted, coffee_ground
```

Order in the grid is fixed (matches the list above) — no dynamic reordering, keeps the layout stable across visits.

## Data flow

### Opening `/pantry`

1. Server Component runs `listPantry()` and `select('id, name').from('canonical_ingredients')` in parallel.
2. Passes both to `<PantryPage>` (client wrapper).
3. Client wrapper initializes a `useState<Set<string>>(pantryIds)` and hands it to the three widgets. Every mutation reads/writes this shared state.

### Checking a shopping-list item

1. Client optimistically strikes the row.
2. Server Action: upsert `shopping_list_checks` **and** `INSERT INTO pantry (...) ON CONFLICT DO NOTHING`.
3. `revalidatePath('/plan/shopping-list')` re-renders. The extended `buildShoppingList` now sees the canonical in the live pantry union and filters the row out entirely — the check state becomes moot because the row is gone.

### Tapping a staple chip

1. Client toggles the chip's activated state optimistically and updates the shared `Set`.
2. If newly active → `addToPantry(canonicalId)`. If newly inactive → `removeFromPantry(canonicalId)`.
3. Server Action revalidates `/pantry` and `/plan/shopping-list`.
4. Middle "current pantry" list re-renders and shows/hides the row.

### Removing via ×

Same as tap-off in the staples grid, but originating from the middle list. Same `removeFromPantry` action.

### Search-add

1. Client filters the preloaded canonical list on each keystroke (client-side, no server round-trip).
2. Selecting a result calls `addToPantry`.
3. Input clears; the chip in the middle list appears (and any matching staple chip flips to activated).

## Error handling

Pattern mirrors `app/plan/shopping-list/`:

- Each mutation is wrapped in `useTransition` with optimistic update + rollback on error.
- **Rapid-toggle guard:** a `Set<string>` of pending canonical IDs; new taps for a canonical already in-flight are ignored until the promise resolves.
- On error, an inline text line appears beneath the widget: `"Could not update pantry — try again"`. No modal.
- **Server Action idempotency:**
  - `addToPantry`: `INSERT ... ON CONFLICT (canonical_ingredient_id) DO NOTHING`.
  - `removeFromPantry`: `DELETE WHERE canonical_ingredient_id = $1`.
  - Both safe to retry.
- **FK violation on stale staple ID:** if a hardcoded staple isn't in `canonical_ingredients`, the insert fails on the FK. Guarded at build time by a Vitest that asserts every `STAPLE_CANONICAL_IDS` entry is in `CANONICAL_INGREDIENTS`.

## Testing

**Vitest — new:**

- `tests/pantry/staples.test.ts`
  - Every `STAPLE_CANONICAL_IDS` entry is present in `CANONICAL_INGREDIENTS`.

**Vitest — extend `tests/meal-planner/shopping-list.test.ts`:**

- Live-pantry-only ID → ingredient row filtered.
- Snapshot + live overlap → filtered once, no double count in totals.
- Snapshot excludes A, live pantry excludes B, ingredients contain A/B/C → only C in output.

**Not writing tests for:**

- `addToPantry` / `removeFromPantry` (thin Supabase wrappers, same rationale as existing `toggleItemAction`).
- Page components (same rationale as `app/plan/shopping-list/page.tsx`).
- Autocomplete widget (pure client UI, low risk, not worth the RTL setup for one page).

**Manual smoke test (belongs in the plan doc's verification section):**

1. Fresh state: `/pantry` shows empty middle list, all staple chips inactive.
2. Tap "Olive Oil" chip → chip activates → visit `/plan/shopping-list` → olive oil is gone if it was on the list.
3. On the shopping list, check off "Eggs" → row disappears → `/pantry` shows Eggs as an activated staple chip **and** in the current-pantry list.
4. Uncheck a hypothetical still-visible item → pantry unchanged.
5. Search "cin" → cinnamon appears → tap → cinnamon shows in the current-pantry list.
6. Tap × on cinnamon → removed from the list; staple chips unchanged.
7. Regenerate the plan → new plan snapshot includes new pantry contents; olive oil / eggs / cinnamon absent from the fresh shopping list.

## Milestone slotting

This is week 5**a** of the design-spec's week 5 (Pantry state + Vercel Cron weekly refresh + Health dashboard + Meal ratings). Subsequent sub-plans (5b–5d) cover the other three deliverables independently.

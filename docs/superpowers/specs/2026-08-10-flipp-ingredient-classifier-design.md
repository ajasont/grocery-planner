# Flipp ingredient classifier — design

**Date:** 2026-08-10
**Status:** Design approved

## Problem

The Flipp/Sprouts flyer ingests every priced item as a `retailer_skus` row and passes them all to the Haiku mapper. Non-food items leak through: `Large Rose Bunches`, `Non-GMO Bulk Candy`, `Eternal Spring Water`, `MADE-TO-ORDER SANDWICHES` (which the mapper hallucinated onto `bread_sliced` at 0.3 confidence). The visible symptoms are:

1. The home page "This Week's Deals" list on `/` shows non-ingredients directly (via `getCurrentWeekOnSaleDeals`, which doesn't filter).
2. The mapper wastes Haiku tokens trying to map non-ingredients and occasionally succeeds with garbage mappings that then poison the meal planner and shopping list.

Kroger/Harris Teeter is search-scoped (`filter.term=chicken`, `filter.term=beef`), so its output is already narrow; the noise problem is Flipp-only.

## Goals

- Filter non-ingredients out of Flipp ingest cleanly, with an audit trail (not a hard-delete).
- Prevent the mapper from processing non-ingredients (saves tokens, prevents bad mappings).
- Clear existing bad mappings on flagged rows in one pass.
- Backfill existing 57 Flipp SKUs on the next cron run without a separate script.
- Full health-surfacing parity with the mapper — status card, `job_runs` counters, and detection of silent write failures per the design principles codified in the 2026-08-10 `/health` incident.

## Non-goals

- HT/Kroger classification (out of scope; already search-scoped).
- Improving mapper recall on unmapped-but-legitimate HT items (separate quality issue).
- Building an admin UI to review/override classifications (future work if false positives surface).
- Adding classifier history to `/health` (only current status; add later if failures become frequent).

## Architecture

Weekly cron pipeline (order matters):

```
refresh HT + Sprouts (parallel, existing)
        ↓
runClassificationForUnclassifiedFlippSkus()  ← NEW: classifies is_ingredient IS NULL AND sku LIKE 'flipp-%'
        ↓                                       (cascade-clears canonical_ingredient_id on flagged rows)
runMappingForUnmappedSkus()                  ← existing, unchanged in behavior; sees only ingredients now
        ↓
insert job_runs row                          ← extended with classifier_status/classified/flagged/failed/error
```

Classifier failure does **not** abort the mapper — mapper still runs on whatever it can see. Failure is recorded in `job_runs` and surfaced on `/health`. This matches how the mapper currently handles retailer failures: soft-fail with visibility.

## Schema

Migration `supabase/migrations/0005_flipp_classification.sql`:

```sql
alter table retailer_skus
  add column is_ingredient boolean,
  add column classification_confidence numeric,
  add column classification_reason text;

create index idx_retailer_skus_unclassified_flipp
  on retailer_skus (id)
  where is_ingredient is null and sku like 'flipp-%';

alter table job_runs
  add column classifier_status text check (classifier_status in ('OK', 'FAILED')),
  add column classifier_classified int not null default 0,
  add column classifier_flagged int not null default 0,
  add column classifier_failed int not null default 0,
  add column classifier_error text;
```

- `is_ingredient boolean` nullable, three states: `NULL = unclassified`, `true = ingredient`, `false = non-ingredient`.
- `classification_confidence numeric` 0–1, mirrors `mapping_confidence`.
- `classification_reason text` short freeform from Haiku (`"floral"`, `"prepared food"`, `"beverage"`, `"candy"`) for debugging false positives.
- Partial index keeps the runner's select cheap without indexing rows never scanned.
- `classifier_status` nullable so existing `job_runs` rows survive (pre-migration history has NULL).

**No `retailer_health` change.** The mapper is tracked purely via `job_runs`; the classifier follows the same pattern. `retailer_health.retailer_id` is a NOT NULL FK to `retailers(id)` with UNIQUE, so there's no clean way to shoehorn in a sentinel row and no reason to.

## Classifier module

New file `lib/normalization/classifier.ts`, sibling to `mapper.ts`:

```typescript
export type ClassificationResult = {
  is_ingredient: boolean;
  confidence: number;
  reason: string;
};

export async function classifyProductNames(
  names: string[]
): Promise<ClassificationResult[]>;
```

Uses the same Anthropic client and `MODEL = 'claude-haiku-4-5'` as the mapper. One batched call per invocation. Returns results in input order, one per input name.

System prompt shape:

> Classify each grocery-flyer item as **food ingredient** (something a person would cook with or eat as a meal component) or not.
>
> **Ingredient (`true`):** raw or minimally-processed foods, packaged staples (pasta, canned tomatoes, cereal), dairy, meat/fish, produce, oils/vinegars, spices, baking supplies.
>
> **Not an ingredient (`false`):** flowers, non-food merchandise, cleaning/household products, bottled beverages sold as drinks (soda, sports drinks, plain water), candy/snack bars, prepared deli items ("MADE-TO-ORDER SANDWICHES"), pharmacy items, gift cards.
>
> **When in doubt, return `true`** — showing an occasional non-ingredient is cheaper than hiding a real one.
>
> Return a JSON array in input order: `{"is_ingredient": bool, "confidence": 0–1, "reason": "short phrase"}`.

Named-example guardrails in the prompt (mirrors mapper convention):

| Input | Output |
|---|---|
| `Large Rose Bunches` | `{is_ingredient: false, reason: "floral"}` |
| `MADE-TO-ORDER SANDWICHES` | `{is_ingredient: false, reason: "prepared deli item"}` |
| `Eternal Spring Water` | `{is_ingredient: false, reason: "beverage"}` |
| `Non-GMO Bulk Candy` | `{is_ingredient: false, reason: "candy"}` |
| `Boneless Chicken Breast` | `{is_ingredient: true, reason: "meat"}` |
| `Baby Spinach` | `{is_ingredient: true, reason: "produce"}` |
| `Whole Milk` | `{is_ingredient: true, reason: "dairy"}` |

**Failure semantics:** schema-invalid response, length mismatch, or API error → throw. Caller records `classifier_status='FAILED'`.

## Classifier runner

New file `lib/normalization/classifier-runner.ts`, sibling to `runner.ts`:

```typescript
export type ClassifierRunResult = {
  classified: number;
  flagged: number;
  failed: number;
};

export async function runClassificationForUnclassifiedFlippSkus(): Promise<ClassifierRunResult>;
```

Behavior:

1. `select id, product_name, canonical_ingredient_id from retailer_skus where is_ingredient is null and sku like 'flipp-%'` (uses the partial index).
2. Return `{0, 0, 0}` if empty (no Haiku call).
3. Batch call `classifyProductNames(names)`.
4. For each row, `update retailer_skus set is_ingredient, classification_confidence, classification_reason where id = ?`. Per-row DB errors count as `failed`, batch continues.
5. **Cascade clear:** for rows where `is_ingredient=false AND canonical_ingredient_id IS NOT NULL`, additionally set `canonical_ingredient_id=null, mapping_confidence=null` in the same update — fixes existing bad mappings like `MADE-TO-ORDER SANDWICHES → bread_sliced`.
6. Classifier call throws → propagate to caller.

## Cron wiring

`app/api/jobs/weekly-refresh/route.ts` inserts the classifier step between retailer refresh and mapper. Endpoint response extends with `classifier: { status, classified, flagged, failed }` alongside the existing `mapper` block.

Classifier failure is recorded in `job_runs` but does not throw — the mapper still runs afterward on whatever is currently unmapped and not-flagged.

## `/health` surfacing

Extend `HealthSnapshot`:

```typescript
export type ClassifierStatus = {
  runAt: string;
  status: 'OK' | 'FAILED';
  classified: number;
  flagged: number;
  failed: number;
  error: string | null;
};

export type HealthSnapshot = {
  hasProblem: boolean;
  retailers: RetailerStatus[];
  mapper: MapperStatus | null;
  classifier: ClassifierStatus | null;   // NEW
  history: MapperStatus[];
  mapperHistoryStale: boolean;
};
```

`computeHealth()` extends the `job_runs` projection to include `classifier_*` columns and derives `ClassifierStatus` from the same row that produces `MapperStatus` (they share `run_at` — same insert). `classifier: null` when `classifier_status IS NULL` (pre-migration rows or classifier didn't run).

`hasProblem` gets one clause: `(classifier !== null && classifier.status === 'FAILED')`.

`/health` page adds a "Classifier" card between the mapper card and the mapper history section, copy-paste of the mapper card structure. Red border on FAILED.

`HealthBanner` on `/plan`:
- `problemCount` includes `(classifier?.status === 'FAILED' ? 1 : 0)`.
- Single-problem message priority: retailer → mapper → classifier → mapperHistoryStale → "Refresh problems detected" (2+).

**No `classifierHistoryStale`.** `mapperHistoryStale` already detects "job_runs isn't being written" (both writes happen in the same cron insert), so the same signal covers the classifier for free.

## Downstream reads

Three consumers of Flipp deals; two are already safe.

**Already safe (no change):**
- `lib/meal-planner/inputs.ts:cheapestByCanonical` filters `!r.canonical_id` (line 21).
- `lib/meal-planner/shopping-list.ts` filters `canonical_ingredient_id !== null` (line 313).

Both work because the classifier cascade-clears `canonical_ingredient_id` on flagged rows.

**Needs change:** `lib/deals/read.ts:getCurrentWeekOnSaleDeals` (used by home page `/`). Add:

```typescript
.not('retailer_skus.is_ingredient', 'is', false)
```

`IS NOT FALSE` semantics — hides only rows explicitly `false`. NULL (unclassified) and `true` both pass. HT items (always NULL) still show. Flipp items not yet classified still show — they'll be classified on the next cron.

## Failure modes

| Failure | Behavior |
|---|---|
| Classifier Haiku call throws | Runner throws → cron records `classifier_status='FAILED'` + `classifier_error`; mapper still runs; `/health` red Classifier card; `/plan` shows problem count. |
| Per-row DB update fails | Counted as `failed`, batch continues (mirrors mapper). |
| Haiku returns schema-invalid response | Runner throws → same path as above. |
| Haiku returns fewer results than inputs | Runner throws. |
| Classifier writes but `job_runs` insert fails silently | Already caught by `mapperHistoryStale` divergence check — no new plumbing needed. |
| Migration not applied (`is_ingredient` column missing) | Classifier update throws immediately, cron records failure. |

## Testing plan (all TDD)

- `tests/normalization/classifier.test.ts` — 4 tests: happy, length mismatch, schema invalid, API error propagation.
- `tests/normalization/classifier-runner.test.ts` — 6 tests: happy, empty select, flagged-with-existing-canonical cascade clear, flagged-without-existing-canonical skip cascade, per-row DB fail counted, classifier throw propagates.
- `tests/health/status.test.ts` — 4 new tests: classifier derived from job_runs when present, FAILED sets `hasProblem`, NULL `classifier_status` yields `classifier: null`, `hasProblem` composition.
- `tests/deals/read.test.ts` — 2–3 new tests: `is_ingredient=false` excluded; `true` and NULL pass through.
- `tests/ingestion/refresh.test.ts` or cron endpoint test — classifier runs before mapper; counters land in `job_runs`.

## Deploy sequence

1. Apply migration `0005_flipp_classification.sql` via Supabase Dashboard SQL Editor.
2. Merge PR.
3. Vercel auto-deploys.
4. Wait for 2026-08-16 14:00 UTC cron. Classifier runs over all 57 existing Flipp SKUs (backfill), then mapper on whatever's left, populates `job_runs` with classifier fields.
5. Verify on `/health`: Classifier card shows OK with ~57 classified, some flagged.
6. Verify on `/`: known noise items (roses, bulk candy, MADE-TO-ORDER SANDWICHES) gone from "This Week's Deals".

## Rollback

Revert PR — `is_ingredient` filter in `getCurrentWeekOnSaleDeals` disappears, home page shows Flipp noise again but nothing breaks. Migration is additive; safe to leave in place. Cleared `canonical_ingredient_id` values on flagged rows will remain cleared until the mapper re-runs, at which point they'll be re-mapped (potentially back to the bad mappings). Not a concern for a revert scenario.

## Design principles applied

- **Best-effort write paired with hard-throwing read is a footgun** — the classifier update is best-effort per-row (counts failures, doesn't throw); `computeHealth()`'s `job_runs` read is already defensive as of PR #6.
- **Silent write failures need read-side divergence checks** — `mapperHistoryStale` already covers "job_runs not being written" for both mapper and classifier; no new divergence check needed since both share the same insert.

# Flipp Ingredient Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Haiku-driven classifier that flags Flipp SKUs as ingredient-or-not, runs before the mapper in the weekly cron, cascade-clears bad canonical mappings, and gets full `/health` parity with the mapper.

**Architecture:** New `classifier` module + `classifier-runner` sibling to the mapper. Runner selects Flipp SKUs where `is_ingredient IS NULL`, batch-classifies via Haiku tool-use, updates rows, and clears `canonical_ingredient_id` for flagged rows. Cron calls classifier before mapper. `computeHealth()` derives a new `ClassifierStatus` from the same `job_runs` row that produces `MapperStatus`. Home-page deals filter adds `is_ingredient IS NOT FALSE`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Anthropic SDK (Haiku 4.5), Vitest.

**Design spec:** `docs/superpowers/specs/2026-08-10-flipp-ingredient-classifier-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/0005_flipp_classification.sql` — schema migration.
- `lib/normalization/classifier.ts` — Haiku classifier module (mirrors `mapper.ts`).
- `lib/normalization/classifier-runner.ts` — batch runner (mirrors `runner.ts`).
- `tests/normalization/classifier.test.ts` — classifier unit tests.
- `tests/normalization/classifier-runner.test.ts` — runner unit tests.
- `tests/deals/read.test.ts` — `getCurrentWeekOnSaleDeals` filter tests.

**Modify:**
- `lib/health/status.ts` — add `ClassifierStatus`, extend `HealthSnapshot`, extend `job_runs` projection, derive classifier, extend `hasProblem`.
- `tests/health/status.test.ts` — add helper for classifier fields, add 4 new tests.
- `app/health/page.tsx` — add `ClassifierCard` component and render between Mapper section and Recent runs.
- `app/plan/HealthBanner.tsx` — include classifier failure in `problemCount` and message priority.
- `lib/deals/read.ts` — add `.not('retailer_skus.is_ingredient', 'is', false)` to the deals query.
- `app/api/jobs/weekly-refresh/route.ts` — call `runClassificationForUnclassifiedFlippSkus` before the mapper; extend `job_runs` insert.
- `tests/api/weekly-refresh.test.ts` — add classifier mock, extend expectations for new insert shape.

---

## Task 1: Migration `0005_flipp_classification.sql`

**Files:**
- Create: `supabase/migrations/0005_flipp_classification.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/0005_flipp_classification.sql` with:

```sql
-- Flipp ingredient classifier (see docs/superpowers/plans/2026-08-10-flipp-ingredient-classifier.md).
-- Adds three nullable columns on retailer_skus + a partial index for the runner's select.
-- Also extends job_runs with classifier counters, mirroring the existing mapper_* columns.

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

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0005_flipp_classification.sql
git commit -m "Add 0005 migration: flipp classification columns + job_runs classifier counters"
```

Note: this migration is applied manually via Supabase Dashboard SQL Editor as part of the deploy sequence (see the design spec). It is not applied by the test suite — tests mock the DB.

---

## Task 2: Classifier module

**Files:**
- Create: `lib/normalization/classifier.ts`
- Create: `tests/normalization/classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/normalization/classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

import { classifyProductNames } from '@/lib/normalization/classifier';

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('classifyProductNames', () => {
  it('returns one result per input in order', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: true, confidence: 0.95, reason: 'meat' },
              { index: 1, is_ingredient: false, confidence: 0.9, reason: 'floral' },
            ],
          },
        },
      ],
    });

    const result = await classifyProductNames([
      'Boneless Chicken Breast',
      'Large Rose Bunches',
    ]);

    expect(result).toEqual([
      { is_ingredient: true, confidence: 0.95, reason: 'meat' },
      { is_ingredient: false, confidence: 0.9, reason: 'floral' },
    ]);
  });

  it('returns [] for empty input without calling Haiku', async () => {
    const result = await classifyProductNames([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defaults to is_ingredient=true when Haiku omits an index (safety)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: false, confidence: 0.9, reason: 'candy' },
            ],
          },
        },
      ],
    });

    const result = await classifyProductNames(['Bulk Candy', 'Missing Item']);
    expect(result[0]).toEqual({ is_ingredient: false, confidence: 0.9, reason: 'candy' });
    // Missing index: default to true / confidence 0 / empty reason so nothing gets hidden by omission.
    expect(result[1]).toEqual({ is_ingredient: true, confidence: 0, reason: '' });
  });

  it('sends a system prompt with the named-example guardrails on every batch', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: true, confidence: 0.9, reason: 'meat' },
            ],
          },
        },
      ],
    });

    await classifyProductNames(['Boneless Chicken Breast']);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0] as { system?: string };
    expect(typeof args.system).toBe('string');
    // Guardrails: the prompt must reference the known noise categories so a
    // future edit that drops them fails this test.
    expect(args.system).toMatch(/Rose/i);
    expect(args.system).toMatch(/MADE-TO-ORDER/i);
    expect(args.system).toMatch(/Water/i);
    expect(args.system).toMatch(/Candy/i);
    // "When in doubt, return true" safety net.
    expect(args.system).toMatch(/doubt/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/normalization/classifier.test.ts`

Expected: FAIL with "Cannot find module '@/lib/normalization/classifier'".

- [ ] **Step 3: Write minimal implementation**

Create `lib/normalization/classifier.ts`:

```typescript
import { getAnthropicClient } from '@/lib/anthropic/client';

export type ClassificationResult = {
  is_ingredient: boolean;
  confidence: number;
  reason: string;
};

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are classifying grocery-store flyer items to decide whether each one is a food ingredient — something a person would use to cook a meal or eat as a component of a meal.

Ingredient (is_ingredient: true): raw or minimally-processed foods, packaged staples (pasta, canned tomatoes, cereal), dairy, meat/fish, produce, oils/vinegars, spices, baking supplies.

Not an ingredient (is_ingredient: false): flowers, non-food merchandise, cleaning/household products, bottled beverages sold as drinks (soda, sports drinks, plain water), candy and snack bars marketed as impulse buys, prepared deli items ("MADE-TO-ORDER SANDWICHES"), pharmacy items, gift cards.

When in doubt, return true — the cost of showing an occasional non-ingredient is much lower than hiding a real one.

Examples:
- "Large Rose Bunches" → { is_ingredient: false, reason: "floral" }
- "MADE-TO-ORDER SANDWICHES" → { is_ingredient: false, reason: "prepared deli item" }
- "Eternal Spring Water" → { is_ingredient: false, reason: "beverage" }
- "Non-GMO Bulk Candy" → { is_ingredient: false, reason: "candy" }
- "Boneless Chicken Breast" → { is_ingredient: true, reason: "meat" }
- "Baby Spinach" → { is_ingredient: true, reason: "produce" }
- "Whole Milk" → { is_ingredient: true, reason: "dairy" }`;

const TOOL = {
  name: 'classify_ingredients',
  description:
    'For each numbered product name, classify whether it is a food ingredient. Return a short reason phrase for each (e.g. "floral", "prepared food", "meat", "produce"). Confidence is 0.0 (guess) to 1.0 (certain).',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            is_ingredient: { type: 'boolean' },
            confidence: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['index', 'is_ingredient', 'confidence', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
} as const;

export async function classifyProductNames(
  names: string[]
): Promise<ClassificationResult[]> {
  if (names.length === 0) return [];
  const client = getAnthropicClient();

  // Default to is_ingredient=true so an omitted index never hides a real product.
  const results: ClassificationResult[] = new Array(names.length)
    .fill(null)
    .map(() => ({ is_ingredient: true, confidence: 0, reason: '' }));

  const numbered = names.map((n, i) => `${i}. ${n}`).join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [TOOL as any],
    tool_choice: { type: 'tool', name: 'classify_ingredients' },
    messages: [
      {
        role: 'user',
        content: `Classify these product names:\n${numbered}`,
      },
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUse = (response.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse) return results;
  const classifications = (toolUse.input?.classifications ?? []) as Array<{
    index: number;
    is_ingredient: boolean;
    confidence: number;
    reason: string;
  }>;

  for (const c of classifications) {
    if (c.index < 0 || c.index >= names.length) continue;
    results[c.index] = {
      is_ingredient: typeof c.is_ingredient === 'boolean' ? c.is_ingredient : true,
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      reason: typeof c.reason === 'string' ? c.reason : '',
    };
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/normalization/classifier.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/normalization/classifier.ts tests/normalization/classifier.test.ts
git commit -m "Add Flipp ingredient classifier (Haiku)"
```

---

## Task 3: Classifier runner

**Files:**
- Create: `lib/normalization/classifier-runner.ts`
- Create: `tests/normalization/classifier-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/normalization/classifier-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClassify = vi.fn();
vi.mock('@/lib/normalization/classifier', () => ({
  classifyProductNames: (names: string[]) => mockClassify(names),
}));

type UpdateEqResult = { error: { message: string } | null };
const mockUpdateEq = vi.fn<
  (payload: unknown, col: string, val: unknown) => Promise<UpdateEqResult>
>(async () => ({ error: null }));
const mockUpdate = vi.fn((payload: unknown) => ({
  eq: (col: string, val: unknown) => mockUpdateEq(payload, col, val),
}));
const mockSelect = vi.fn();

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'retailer_skus') {
        return {
          select: () => ({
            is: () => ({ like: () => mockSelect() }),
          }),
          update: mockUpdate,
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { runClassificationForUnclassifiedFlippSkus } from '@/lib/normalization/classifier-runner';

beforeEach(() => {
  mockClassify.mockReset();
  mockUpdate.mockClear();
  mockUpdateEq.mockReset().mockResolvedValue({ error: null });
  mockSelect.mockReset();
});

describe('runClassificationForUnclassifiedFlippSkus', () => {
  it('classifies unclassified Flipp SKUs and writes is_ingredient/confidence/reason', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'Boneless Chicken Breast', canonical_ingredient_id: null },
        { id: 2, product_name: 'Baby Spinach', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: true, confidence: 0.95, reason: 'meat' },
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockClassify).toHaveBeenCalledWith(['Boneless Chicken Breast', 'Baby Spinach']);
    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: true,
        classification_confidence: 0.95,
        classification_reason: 'meat',
      },
      'id',
      1
    );
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      2,
      {
        is_ingredient: true,
        classification_confidence: 0.9,
        classification_reason: 'produce',
      },
      'id',
      2
    );
    expect(result).toEqual({ classified: 2, flagged: 0, failed: 0 });
  });

  it('returns {0,0,0} when no unclassified SKUs exist without calling the classifier', async () => {
    mockSelect.mockResolvedValueOnce({ data: [], error: null });

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockUpdateEq).not.toHaveBeenCalled();
    expect(result).toEqual({ classified: 0, flagged: 0, failed: 0 });
  });

  it('cascade-clears canonical_ingredient_id and mapping_confidence when is_ingredient=false and a mapping exists', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        {
          id: 42,
          product_name: 'MADE-TO-ORDER SANDWICHES',
          canonical_ingredient_id: 'bread_sliced',
        },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: false, confidence: 0.9, reason: 'prepared deli item' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(1);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: false,
        classification_confidence: 0.9,
        classification_reason: 'prepared deli item',
        canonical_ingredient_id: null,
        mapping_confidence: null,
      },
      'id',
      42
    );
    expect(result).toEqual({ classified: 1, flagged: 1, failed: 0 });
  });

  it('skips cascade-clear when is_ingredient=false but no existing canonical mapping', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 7, product_name: 'Large Rose Bunches', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: false, confidence: 0.95, reason: 'floral' },
    ]);

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(1);
    expect(mockUpdateEq).toHaveBeenNthCalledWith(
      1,
      {
        is_ingredient: false,
        classification_confidence: 0.95,
        classification_reason: 'floral',
      },
      'id',
      7
    );
    expect(result).toEqual({ classified: 1, flagged: 1, failed: 0 });
  });

  it('counts DB update failures without aborting the batch', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'A', canonical_ingredient_id: null },
        { id: 2, product_name: 'B', canonical_ingredient_id: null },
      ],
      error: null,
    });
    mockClassify.mockResolvedValueOnce([
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
      { is_ingredient: true, confidence: 0.9, reason: 'produce' },
    ]);
    mockUpdateEq
      .mockResolvedValueOnce({ error: { message: 'fk violation' } })
      .mockResolvedValueOnce({ error: null });

    const result = await runClassificationForUnclassifiedFlippSkus();

    expect(mockUpdateEq).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ classified: 1, flagged: 0, failed: 1 });
  });

  it('propagates classifier throws', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [{ id: 1, product_name: 'A', canonical_ingredient_id: null }],
      error: null,
    });
    mockClassify.mockRejectedValueOnce(new Error('Anthropic 503'));

    await expect(runClassificationForUnclassifiedFlippSkus()).rejects.toThrow(
      /Anthropic 503/
    );
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/normalization/classifier-runner.test.ts`

Expected: FAIL with "Cannot find module '@/lib/normalization/classifier-runner'".

- [ ] **Step 3: Write minimal implementation**

Create `lib/normalization/classifier-runner.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';
import { classifyProductNames } from './classifier';

export type ClassifierRunResult = {
  classified: number;
  flagged: number;
  failed: number;
};

export async function runClassificationForUnclassifiedFlippSkus(): Promise<ClassifierRunResult> {
  const supabase = getServerClient();

  // Uses the partial index idx_retailer_skus_unclassified_flipp.
  const { data, error } = await supabase
    .from('retailer_skus')
    .select('id, product_name, canonical_ingredient_id')
    .is('is_ingredient', null)
    .like('sku', 'flipp-%');
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: number;
    product_name: string;
    canonical_ingredient_id: string | null;
  }>;
  if (rows.length === 0) return { classified: 0, flagged: 0, failed: 0 };

  const classifications = await classifyProductNames(rows.map((r) => r.product_name));

  let classified = 0;
  let flagged = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const c = classifications[i];
    if (!c) {
      failed++;
      continue;
    }
    const payload: {
      is_ingredient: boolean;
      classification_confidence: number;
      classification_reason: string;
      canonical_ingredient_id?: null;
      mapping_confidence?: null;
    } = {
      is_ingredient: c.is_ingredient,
      classification_confidence: c.confidence,
      classification_reason: c.reason,
    };
    // Cascade-clear a bad mapping when we're now flagging as non-ingredient.
    if (c.is_ingredient === false && row.canonical_ingredient_id !== null) {
      payload.canonical_ingredient_id = null;
      payload.mapping_confidence = null;
    }
    const { error: upErr } = await supabase
      .from('retailer_skus')
      .update(payload)
      .eq('id', row.id);
    if (upErr) {
      failed++;
      console.warn(
        `classifier update failed for id=${row.id}:`,
        upErr
      );
      continue;
    }
    classified++;
    if (c.is_ingredient === false) flagged++;
  }

  return { classified, flagged, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/normalization/classifier-runner.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/normalization/classifier-runner.ts tests/normalization/classifier-runner.test.ts
git commit -m "Add classifier runner with cascade-clear for flagged rows"
```

---

## Task 4: Extend `computeHealth` with `ClassifierStatus`

**Files:**
- Modify: `lib/health/status.ts`
- Modify: `tests/health/status.test.ts`

- [ ] **Step 1: Add a helper + write 4 failing tests**

At the top of `tests/health/status.test.ts`, add a new helper next to the existing `jobRunRow` (after line 81):

```typescript
function jobRunRowWithClassifier(
  runAt: string,
  status: 'OK' | 'FAILED',
  counts: { mapped: number; skipped: number; failed: number },
  classifier: {
    status: 'OK' | 'FAILED' | null;
    classified?: number;
    flagged?: number;
    failed?: number;
    error?: string | null;
  } = { status: null },
  error: string | null = null
) {
  return {
    run_at: runAt,
    mapper_status: status,
    mapper_mapped: counts.mapped,
    mapper_skipped: counts.skipped,
    mapper_failed: counts.failed,
    mapper_error: error,
    classifier_status: classifier.status,
    classifier_classified: classifier.classified ?? 0,
    classifier_flagged: classifier.flagged ?? 0,
    classifier_failed: classifier.failed ?? 0,
    classifier_error: classifier.error ?? null,
  };
}
```

Then append a new `describe` block at the end of the file:

```typescript
describe('computeHealth — classifier', () => {
  it('derives classifier from the newest job_runs row when classifier_status is present', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-16T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-16T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRowWithClassifier(
          '2026-08-16T14:10:00.000Z',
          'OK',
          { mapped: 100, skipped: 5, failed: 0 },
          { status: 'OK', classified: 57, flagged: 12, failed: 0, error: null }
        ),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.classifier).toEqual({
      runAt: '2026-08-16T14:10:00.000Z',
      status: 'OK',
      classified: 57,
      flagged: 12,
      failed: 0,
      error: null,
    });
    expect(health.hasProblem).toBe(false);
  });

  it('is null when the newest job_runs row has classifier_status NULL (pre-migration history)', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-02T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-02T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRowWithClassifier(
          '2026-08-02T14:10:00.000Z',
          'OK',
          { mapped: 100, skipped: 5, failed: 0 },
          { status: null }
        ),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.classifier).toBeNull();
    expect(health.hasProblem).toBe(false);
  });

  it('is null when there are no job_runs at all', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-16T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-16T14:07:00.000Z'),
      ],
      error: null,
    });
    // job_runs stays empty (default mock).

    const health = await computeHealth();
    expect(health.classifier).toBeNull();
  });

  it('sets hasProblem=true when classifier status is FAILED, retailers and mapper OK', async () => {
    retailerHealthRowsSpy.mockResolvedValueOnce({
      data: [
        retailerHealthRow('harris-teeter', 'OK', '2026-08-16T14:05:00.000Z'),
        retailerHealthRow('sprouts', 'OK', '2026-08-16T14:07:00.000Z'),
      ],
      error: null,
    });
    jobRunsRowsSpy.mockResolvedValueOnce({
      data: [
        jobRunRowWithClassifier(
          '2026-08-16T14:10:00.000Z',
          'OK',
          { mapped: 100, skipped: 5, failed: 0 },
          {
            status: 'FAILED',
            classified: 0,
            flagged: 0,
            failed: 0,
            error: 'Anthropic 503',
          }
        ),
      ],
      error: null,
    });

    const health = await computeHealth();

    expect(health.classifier?.status).toBe('FAILED');
    expect(health.classifier?.error).toBe('Anthropic 503');
    expect(health.hasProblem).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health/status.test.ts -t 'classifier'`

Expected: FAIL with `health.classifier` undefined or similar.

- [ ] **Step 3: Extend `lib/health/status.ts`**

Add the `ClassifierStatus` type + row type + derivation. Modify the file as follows.

Add after the existing `MapperStatus` type (currently ends at line 36):

```typescript
export type ClassifierStatus = {
  runAt: string;
  status: 'OK' | 'FAILED';
  classified: number;
  flagged: number;
  failed: number;
  error: string | null;
};
```

Modify `HealthSnapshot` to include `classifier`:

```typescript
export type HealthSnapshot = {
  hasProblem: boolean;
  retailers: RetailerStatus[];
  mapper: MapperStatus | null;
  classifier: ClassifierStatus | null;
  history: MapperStatus[];
  // True when a retailer refresh landed but the paired job_runs row didn't —
  // catches silent write-side failures like a dropped table.
  mapperHistoryStale: boolean;
};
```

Extend the `JobRunRow` type (around line 55) to include classifier fields:

```typescript
type JobRunRow = {
  run_at: string;
  mapper_status: 'OK' | 'FAILED';
  mapper_mapped: number;
  mapper_skipped: number;
  mapper_failed: number;
  mapper_error: string | null;
  classifier_status: 'OK' | 'FAILED' | null;
  classifier_classified: number;
  classifier_flagged: number;
  classifier_failed: number;
  classifier_error: string | null;
};
```

Add a `toClassifierStatus` helper next to the existing `toMapperStatus`:

```typescript
function toClassifierStatus(row: JobRunRow): ClassifierStatus | null {
  if (row.classifier_status === null) return null;
  return {
    runAt: row.run_at,
    status: row.classifier_status,
    classified: row.classifier_classified,
    flagged: row.classifier_flagged,
    failed: row.classifier_failed,
    error: row.classifier_error,
  };
}
```

Extend the `select(...)` on `job_runs` (around line 129) to include the new columns:

```typescript
  const jobRunsRes = (await supabase
    .from('job_runs')
    .select(
      'run_at, mapper_status, mapper_mapped, mapper_skipped, mapper_failed, mapper_error, classifier_status, classifier_classified, classifier_flagged, classifier_failed, classifier_error'
    )
    .order('run_at', { ascending: false })
    .limit(5)) as { data: JobRunRow[] | null; error: unknown };
```

After `const mapper = ...` (around line 149), add:

```typescript
  const classifier = jobRunRows.length > 0 ? toClassifierStatus(jobRunRows[0]) : null;
```

Update `hasProblem` (around line 163) to include classifier:

```typescript
  const hasProblem =
    retailers.some((r) => r.status !== 'OK') ||
    (mapper !== null && mapper.status === 'FAILED') ||
    (classifier !== null && classifier.status === 'FAILED') ||
    mapperHistoryStale;
```

Update the `return` (around line 168) to include `classifier`:

```typescript
  return { hasProblem, retailers, mapper, classifier, history, mapperHistoryStale };
```

- [ ] **Step 4: Run all `status.test.ts` tests to verify they pass**

Run: `npx vitest run tests/health/status.test.ts`

Expected: PASS, all existing tests + 4 new classifier tests. Note: the existing `jobRunRow` helper omits classifier fields, but the code path treats missing `classifier_status` as `null`, so existing tests keep working.

If any existing test fails because it now asserts on `health.classifier`, update it to include `classifier: null` in the expected shape.

- [ ] **Step 5: Commit**

```bash
git add lib/health/status.ts tests/health/status.test.ts
git commit -m "Extend HealthSnapshot with ClassifierStatus derived from job_runs"
```

---

## Task 5: Add `ClassifierCard` to `/health`

**Files:**
- Modify: `app/health/page.tsx`

No unit test — this is a small render change. Visual verification happens on the first cron run after deploy.

- [ ] **Step 1: Update the imports and add a `ClassifierCard` component**

In `app/health/page.tsx`, update the type import (line 3):

```typescript
import type { RetailerStatus, MapperStatus, ClassifierStatus } from '@/lib/health/status';
```

After the existing `MapperCard` component (line 77), add:

```typescript
function ClassifierCard({ c }: { c: ClassifierStatus }) {
  return (
    <div className="rounded border p-3">
      <p className="font-medium">Classifier — last run</p>
      <p className={`text-sm ${c.status === 'OK' ? 'text-green-700' : 'text-red-700'}`}>
        {fmtRunAt(c.runAt)} — {c.status} — {c.classified} classified / {c.flagged} flagged / {c.failed} failed
      </p>
      {c.error && <p className="mt-1 text-xs text-red-700">Error: {c.error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Render the classifier section**

Insert a new `<section>` between the existing Mapper section (ending around line 135) and the Recent runs section (starting around line 137):

```tsx
      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Classifier</h2>
        {health.classifier === null ? (
          <p className="text-sm text-neutral-500">
            No classifier runs yet. First scheduled run: Sunday 14:00 UTC.
          </p>
        ) : (
          <ClassifierCard c={health.classifier} />
        )}
      </section>
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Run full test suite to verify nothing broke**

Run: `npx vitest run`

Expected: all tests pass (no test change; this task only added a UI section).

- [ ] **Step 5: Commit**

```bash
git add app/health/page.tsx
git commit -m "Add Classifier card to /health page"
```

---

## Task 6: Wire classifier into `HealthBanner`

**Files:**
- Modify: `app/plan/HealthBanner.tsx`

No unit test — matches the existing untested-component pattern for this file. The message logic is small and covered by visual verification post-deploy.

- [ ] **Step 1: Update `bannerMessage` to include classifier**

In `app/plan/HealthBanner.tsx`, replace the `bannerMessage` function:

```typescript
function bannerMessage(health: HealthSnapshot): string {
  const problemRetailers = health.retailers.filter((r) => r.status !== 'OK');
  const mapperFailed =
    health.mapper !== null && health.mapper.status === 'FAILED';
  const classifierFailed =
    health.classifier !== null && health.classifier.status === 'FAILED';

  const problemCount =
    problemRetailers.length +
    (mapperFailed ? 1 : 0) +
    (classifierFailed ? 1 : 0) +
    (health.mapperHistoryStale ? 1 : 0);

  if (problemCount >= 2) {
    return 'Refresh problems detected';
  }

  if (problemRetailers.length === 1) {
    const r = problemRetailers[0];
    if (r.status === 'FAILED') {
      return `Sunday refresh failed for ${r.displayName}`;
    }
    if (r.status === 'STALE') {
      const days =
        r.lastSuccessAt !== null
          ? Math.floor(
              (Date.now() - new Date(r.lastSuccessAt).getTime()) /
                (24 * 60 * 60 * 1000)
            )
          : null;
      return days !== null
        ? `No refresh in ${days} days for ${r.displayName}`
        : `No refresh yet for ${r.displayName}`;
    }
    if (r.status === 'NEVER') {
      return `No refresh yet for ${r.displayName}`;
    }
  }

  if (mapperFailed) {
    return 'Ingredient mapping failed on last refresh';
  }

  if (classifierFailed) {
    return 'Ingredient classifier failed on last refresh';
  }

  if (health.mapperHistoryStale) {
    return 'Mapper history not being written';
  }

  return 'Refresh problem detected';
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/plan/HealthBanner.tsx
git commit -m "Include classifier failures in HealthBanner problem count and message"
```

---

## Task 7: Filter non-ingredients in home-page deals read

**Files:**
- Modify: `lib/deals/read.ts`
- Create: `tests/deals/read.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/deals/read.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notCalls: Array<{ column: string; op: string; value: unknown }> = [];
const eqCalls: Array<{ column: string; value: unknown }> = [];
const orderCalls: Array<{ column: string }> = [];

const mockAwait = vi.fn(async () => ({ data: [], error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table !== 'deals') throw new Error('unexpected table ' + table);
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          eqCalls.push({ column, value });
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          notCalls.push({ column, op, value });
          return builder;
        },
        order(column: string) {
          orderCalls.push({ column });
          return mockAwait();
        },
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/dates', () => ({
  getCurrentWeekOfISO: () => '2026-08-10',
}));

import { getCurrentWeekOnSaleDeals } from '@/lib/deals/read';

beforeEach(() => {
  notCalls.length = 0;
  eqCalls.length = 0;
  orderCalls.length = 0;
  mockAwait.mockClear().mockResolvedValue({ data: [], error: null });
});

describe('getCurrentWeekOnSaleDeals', () => {
  it('filters by current week_of and sale_price not null', async () => {
    await getCurrentWeekOnSaleDeals();
    expect(eqCalls).toContainEqual({ column: 'week_of', value: '2026-08-10' });
    expect(notCalls).toContainEqual({
      column: 'sale_price',
      op: 'is',
      value: null,
    });
  });

  it('excludes SKUs explicitly flagged is_ingredient=false', async () => {
    await getCurrentWeekOnSaleDeals();
    expect(notCalls).toContainEqual({
      column: 'retailer_skus.is_ingredient',
      op: 'is',
      value: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/deals/read.test.ts`

Expected: the first test passes (existing behavior), the second FAILS with the new `not(...)` call not present.

- [ ] **Step 3: Add the filter to `lib/deals/read.ts`**

In `lib/deals/read.ts`, modify the query (around lines 11–21). Add one `.not(...)` between the existing `.not('sale_price', ...)` and `.order(...)`. Do NOT change the select projection or the local `Row` type — the filter references the joined column by its FK alias, not by a selected column.

```typescript
  const { data, error } = await supabase
    .from('deals')
    .select(
      `regular_price, sale_price,
       retailer_skus!inner (id, product_name, image_url, canonical_ingredient_id,
         retailers!inner (name),
         canonical_ingredients (name))`
    )
    .eq('week_of', weekOf)
    .not('sale_price', 'is', null)
    .not('retailer_skus.is_ingredient', 'is', false)
    .order('sale_price', { ascending: true });
```

**Runtime verification note:** the unit test asserts the `.not(...)` call was made with the correct args, but does not exercise PostgREST. After deploy, verify the filter is actually applied by curling PostgREST directly:

```
curl "$SUPABASE_URL/rest/v1/deals?select=sale_price,retailer_skus!inner(product_name,is_ingredient)&week_of=eq.<week>&sale_price=not.is.null&retailer_skus.is_ingredient=not.is.false" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq 'length'
```

Compare against the same query without the `is_ingredient` filter — the flagged rows should drop out. If PostgREST rejects the joined-column filter, fall back to `.filter('retailer_skus.is_ingredient', 'not.is', 'false')` or apply the filter in JS after the fetch (post-processing `data`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/deals/read.test.ts`

Expected: PASS, both tests.

- [ ] **Step 5: Run full test suite (regression check)**

Run: `npx vitest run`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/deals/read.ts tests/deals/read.test.ts
git commit -m "Hide non-ingredient Flipp SKUs from home-page deals list"
```

---

## Task 8: Wire classifier into weekly-refresh cron

**Files:**
- Modify: `app/api/jobs/weekly-refresh/route.ts`
- Modify: `tests/api/weekly-refresh.test.ts`

- [ ] **Step 1: Extend existing tests + add classifier tests (RED)**

In `tests/api/weekly-refresh.test.ts`, add a classifier mock near the existing `mockRunMapping` (after line 12):

```typescript
const mockRunClassifier = vi.fn();
vi.mock('@/lib/normalization/classifier-runner', () => ({
  runClassificationForUnclassifiedFlippSkus: () => mockRunClassifier(),
}));
```

Extend `beforeEach` (around line 35) to reset the new mock:

```typescript
beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  mockRefresh.mockReset();
  mockRunMapping.mockReset();
  mockRunClassifier.mockReset();
  jobRunsInsertSpy.mockClear().mockResolvedValue({ error: null });
});
```

Update the two existing "inserts an OK row" and "inserts a FAILED row" tests to (a) provide a classifier mock return, and (b) assert the new insert shape. Replace the two tests with:

```typescript
  it('inserts an OK row when both classifier and mapper succeed', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    mockRunClassifier.mockResolvedValueOnce({ classified: 20, flagged: 5, failed: 0 });
    mockRunMapping.mockResolvedValueOnce({ mapped: 12, skipped: 3, failed: 1 });

    const res = await GET(authorizedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.classifier).toEqual({
      classified: 20,
      flagged: 5,
      failed: 0,
      error: null,
    });
    expect(body.mapper).toEqual({ mapped: 12, skipped: 3, failed: 1, error: null });
    expect(jobRunsInsertSpy).toHaveBeenCalledTimes(1);
    expect(jobRunsInsertSpy).toHaveBeenCalledWith({
      classifier_status: 'OK',
      classifier_classified: 20,
      classifier_flagged: 5,
      classifier_failed: 0,
      classifier_error: null,
      mapper_status: 'OK',
      mapper_mapped: 12,
      mapper_skipped: 3,
      mapper_failed: 1,
      mapper_error: null,
    });
  });

  it('inserts a FAILED mapper row when the mapper throws', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    mockRunClassifier.mockResolvedValueOnce({ classified: 10, flagged: 2, failed: 0 });
    mockRunMapping.mockRejectedValueOnce(new Error('Anthropic 503'));

    const res = await GET(authorizedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mapper.error).toBe('Anthropic 503');
    expect(jobRunsInsertSpy).toHaveBeenCalledWith({
      classifier_status: 'OK',
      classifier_classified: 10,
      classifier_flagged: 2,
      classifier_failed: 0,
      classifier_error: null,
      mapper_status: 'FAILED',
      mapper_mapped: 0,
      mapper_skipped: 0,
      mapper_failed: 0,
      mapper_error: 'Anthropic 503',
    });
  });

  it('inserts a FAILED classifier row and still runs the mapper when the classifier throws', async () => {
    mockRefresh.mockResolvedValue({
      retailer: 'harris-teeter',
      status: 'OK',
      dealsFetched: 3,
      dealsUpserted: 3,
      error: null,
    });
    mockRunClassifier.mockRejectedValueOnce(new Error('Anthropic classifier 503'));
    mockRunMapping.mockResolvedValueOnce({ mapped: 12, skipped: 3, failed: 0 });

    const res = await GET(authorizedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.classifier.error).toBe('Anthropic classifier 503');
    expect(body.mapper.mapped).toBe(12); // mapper still ran
    expect(jobRunsInsertSpy).toHaveBeenCalledWith({
      classifier_status: 'FAILED',
      classifier_classified: 0,
      classifier_flagged: 0,
      classifier_failed: 0,
      classifier_error: 'Anthropic classifier 503',
      mapper_status: 'OK',
      mapper_mapped: 12,
      mapper_skipped: 3,
      mapper_failed: 0,
      mapper_error: null,
    });
  });
```

The existing "still returns 200 when the job_runs insert itself errors" test needs a `mockRunClassifier.mockResolvedValueOnce({ classified: 0, flagged: 0, failed: 0 });` added inside it so the classifier mock is defined; the rest can stay.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/api/weekly-refresh.test.ts`

Expected: FAIL — the cron doesn't call the classifier or write classifier fields yet.

- [ ] **Step 3: Wire the classifier into `app/api/jobs/weekly-refresh/route.ts`**

Replace the file contents with:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer, type RefreshResult } from '@/lib/ingestion/refresh';
import { runClassificationForUnclassifiedFlippSkus } from '@/lib/normalization/classifier-runner';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';
import { getServerClient } from '@/lib/db/client';

const RETAILERS = ['harris-teeter', 'sprouts'] as const;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const settled = await Promise.allSettled(
    RETAILERS.map((r) => refreshRetailer(r))
  );
  const results: RefreshResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          retailer: RETAILERS[i],
          status: 'FAILED',
          dealsFetched: 0,
          dealsUpserted: 0,
          error:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
        }
  );

  // Classifier runs before the mapper so bad rows are gated out of the mapper's select.
  // Failure here does NOT abort the mapper — recorded in job_runs and surfaced on /health.
  let classifier: {
    classified: number;
    flagged: number;
    failed: number;
    error: string | null;
  };
  try {
    const c = await runClassificationForUnclassifiedFlippSkus();
    classifier = {
      classified: c.classified,
      flagged: c.flagged,
      failed: c.failed,
      error: null,
    };
  } catch (err) {
    classifier = {
      classified: 0,
      flagged: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let mapper: {
    mapped: number;
    skipped: number;
    failed: number;
    error: string | null;
  };
  try {
    const m = await runMappingForUnmappedSkus();
    mapper = { mapped: m.mapped, skipped: m.skipped, failed: m.failed, error: null };
  } catch (err) {
    mapper = {
      mapped: 0,
      skipped: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort append to job_runs. A failed write here does not mask the
  // real result: the caller and Vercel logs still show the response envelope.
  // Divergence detection on /health surfaces silent write failures.
  try {
    const supabase = getServerClient();
    const { error } = await supabase.from('job_runs').insert({
      classifier_status: classifier.error === null ? 'OK' : 'FAILED',
      classifier_classified: classifier.classified,
      classifier_flagged: classifier.flagged,
      classifier_failed: classifier.failed,
      classifier_error: classifier.error,
      mapper_status: mapper.error === null ? 'OK' : 'FAILED',
      mapper_mapped: mapper.mapped,
      mapper_skipped: mapper.skipped,
      mapper_failed: mapper.failed,
      mapper_error: mapper.error,
    });
    if (error) {
      console.warn('job_runs insert failed:', error.message);
    }
  } catch (err) {
    console.warn(
      'job_runs insert threw:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return NextResponse.json({
    runAt: new Date().toISOString(),
    results,
    classifier,
    mapper,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/weekly-refresh.test.ts`

Expected: PASS, all 4 tests in the file (401 test + 3 insert tests).

- [ ] **Step 5: Run full test suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`

Expected: all tests pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/jobs/weekly-refresh/route.ts tests/api/weekly-refresh.test.ts
git commit -m "Run classifier before mapper in weekly cron; record classifier fields in job_runs"
```

---

## Task 9: Final full-suite check + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`

Expected: all tests pass.

- [ ] **Step 2: Run tsc**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Verify recent commits**

Run: `git log --oneline main..HEAD`

Expected: 8 commits, one per task above.

- [ ] **Step 4: Push branch and open PR**

Deploy sequence (from the design spec, to be executed by the human after PR is opened):

1. Apply migration `0005_flipp_classification.sql` via Supabase Dashboard SQL Editor.
2. Merge PR — Vercel auto-deploys.
3. Wait for 2026-08-16 14:00 UTC cron. Classifier backfills all 57 existing Flipp SKUs, then mapper runs on the remainder.
4. Verify on `/health`: Classifier card shows OK with ~57 classified, some flagged.
5. Verify on `/`: known noise (roses, bulk candy, MADE-TO-ORDER SANDWICHES) is gone from "This Week's Deals".

---

## Self-review notes

**Spec coverage:**
- Migration → Task 1 ✓
- Classifier module → Task 2 ✓
- Runner (with cascade-clear) → Task 3 ✓
- HealthSnapshot extension → Task 4 ✓
- /health page card → Task 5 ✓
- HealthBanner update → Task 6 ✓
- Downstream `getCurrentWeekOnSaleDeals` filter → Task 7 ✓
- Cron wiring + `job_runs` extension → Task 8 ✓
- Deploy sequence documented → Task 9 ✓

**Type consistency:** `ClassificationResult` and `ClassifierRunResult` names used consistently across Tasks 2, 3, 8. `ClassifierStatus` used consistently across Tasks 4, 5, 6. `is_ingredient` / `classification_confidence` / `classification_reason` column names identical in Tasks 1, 3, and referenced only by name (not by column) in Task 7.

**Placeholder scan:** no TBD/TODO. Every code step contains the actual code the engineer will write.

**One subtlety worth noting for the executor:** Task 4 mentions "if any existing test now asserts on `health.classifier`, update it." Grep suggests no existing test does — but if `expect(health).toEqual(...)` is used anywhere with a full-object matcher, that will break. The test file uses field-by-field asserts (`expect(health.mapper?.status).toBe(...)`), so this is defensive language only.

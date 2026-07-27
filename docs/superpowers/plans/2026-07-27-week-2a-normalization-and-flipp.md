# Week 2a: Normalization Pipeline + Flipp Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **When implementing tasks that call the Anthropic API (Task 3 in particular):** Invoke the `claude-api` skill first. It covers current SDK patterns, prompt caching, and model selection for Claude Haiku 4.5.

**Goal:** Build the Haiku-driven normalization pipeline that maps retailer SKUs to canonical ingredients, and lay the Flipp foundation by adding a universal Flipp client and Sprouts as its first consumer.

**Architecture:** Add a `lib/normalization/` module that batches unmapped `retailer_skus` and asks Claude Haiku 4.5 to pick a canonical ingredient for each, storing results with a confidence score. Add a `lib/ingestion/flipp/` module that hits the reverse-engineered `backflipp.wishabi.com` API and normalizes flyer items to the existing `NormalizedDeal` shape. Refactor the HT-specific persist into a retailer-agnostic `lib/ingestion/persist.ts` so Sprouts (and later retailers) reuse the same DB writes. Wire normalization into the refresh flow so new SKUs get mapped automatically.

**Tech Stack:** Next.js 14, TypeScript, Supabase (Postgres), Anthropic SDK (`@anthropic-ai/sdk` — new dependency), Vitest, MSW for HTTP mocking.

---

## File Structure

**New files (created in this plan):**

- `lib/anthropic/client.ts` — Anthropic SDK client (singleton pattern like `lib/db/client.ts`)
- `lib/normalization/canonical.ts` — Loads canonical ingredient list from DB (cached in-memory per process)
- `lib/normalization/mapper.ts` — Calls Haiku to map product names → canonical IDs
- `lib/normalization/runner.ts` — Queries unmapped SKUs, batches through mapper, writes results back
- `lib/ingestion/persist.ts` — **New** generic persist (replaces `lib/ingestion/harris-teeter/persist.ts`)
- `lib/ingestion/flipp/client.ts` — Flipp merchant lookup + flyer fetch
- `lib/ingestion/flipp/normalize.ts` — Convert Flipp items → `NormalizedDeal[]`
- `lib/ingestion/flipp/types.ts` — Flipp API response types
- `lib/ingestion/sprouts/index.ts` — Sprouts orchestrator (Flipp-only)
- `app/api/admin/refresh-sprouts/route.ts` — Dev-only refresh trigger for Sprouts
- `app/api/admin/map-unmapped/route.ts` — Dev-only trigger to run the mapping runner standalone
- `scripts/map-unmapped.ts` — CLI wrapper for the same
- Tests: `tests/normalization/mapper.test.ts`, `tests/normalization/runner.test.ts`, `tests/ingestion/flipp/client.test.ts`, `tests/ingestion/flipp/normalize.test.ts`, `tests/ingestion/flipp/fixtures/*.json`, `tests/ingestion/sprouts/index.test.ts`

**Modified files:**

- `package.json` — Add `@anthropic-ai/sdk`, add `map:unmapped` script
- `.env.local.example` — Add `ANTHROPIC_API_KEY`
- `lib/ingestion/types.ts` — Add generic `IngestionStore` type
- `app/api/admin/refresh-ht/route.ts` — Use new generic persist; trigger mapping after persist
- `lib/ingestion/harris-teeter/index.ts` — Return generic `IngestionStore[]` instead of HT-specific type (minor tightening)

**Deleted files:**

- `lib/ingestion/harris-teeter/persist.ts` — Replaced by generic `lib/ingestion/persist.ts`

**Untouched (verify):**

- `lib/deals/read.ts` already joins to `retailers.name`, so the home page will automatically render Sprouts deals with no changes required.

---

## Task 1: Install Anthropic SDK and add env var

**Files:**
- Modify: `package.json`
- Modify: `.env.local.example`

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Add `ANTHROPIC_API_KEY` to `.env.local.example`**

Open `.env.local.example` and append (keep existing content):

```
# Anthropic (Haiku for ingredient normalization)
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Populate `.env.local` (user action)**

Set `ANTHROPIC_API_KEY` in your local `.env.local`. Get a key from console.anthropic.com → Settings → API Keys if you don't already have one.

- [ ] **Step 4: Add `ANTHROPIC_API_KEY` to Vercel Production**

```bash
vercel env add ANTHROPIC_API_KEY production
```

Paste the same key when prompted.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.local.example
git commit -m "Add Anthropic SDK dependency for Haiku normalization"
```

---

## Task 2: Anthropic client singleton

**Files:**
- Create: `lib/anthropic/client.ts`

- [ ] **Step 1: Create the client module**

Create `lib/anthropic/client.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  cached = new Anthropic({ apiKey });
  return cached;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/anthropic/client.ts
git commit -m "Add Anthropic client singleton"
```

---

## Task 3: Canonical ingredient loader

**Files:**
- Create: `lib/normalization/canonical.ts`

The Haiku mapper needs the full canonical ingredient list on every call. It's ~218 rows, small enough to cache in memory per process.

- [ ] **Step 1: Create the loader**

Create `lib/normalization/canonical.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';

export type CanonicalMini = {
  id: string;
  name: string;
  category: string | null;
};

let cache: CanonicalMini[] | null = null;

export async function getCanonicalIngredients(): Promise<CanonicalMini[]> {
  if (cache) return cache;
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('canonical_ingredients')
    .select('id, name, category');
  if (error) throw error;
  cache = (data ?? []) as CanonicalMini[];
  return cache;
}

// For tests
export function _resetCanonicalCache() {
  cache = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/normalization/canonical.ts
git commit -m "Add canonical ingredient loader with in-process cache"
```

---

## Task 4: Haiku mapper (TDD)

**IMPORTANT — Before implementing:** Invoke the `claude-api` skill. It has the current best practices for the Anthropic SDK, structured tool use, prompt caching, and Haiku 4.5 model IDs. In particular, use **prompt caching** for the canonical ingredient list (it's static across every call in a batch).

**Files:**
- Create: `lib/normalization/mapper.ts`
- Test: `tests/normalization/mapper.test.ts`

**Contract:** `mapProductNames(names: string[])` returns one result per input name in the same order. Each result is `{ canonical_id: string | null, confidence: number }`. `canonical_id: null` means "no confident match" (Haiku returned `unknown` or below confidence threshold). Confidence is `0.0`–`1.0`.

Batches through Haiku 20 names per call to keep prompts small and latency low.

- [ ] **Step 1: Write the failing test**

Create `tests/normalization/mapper.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK before importing the mapper.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

// Mock the canonical loader
vi.mock('@/lib/normalization/canonical', () => ({
  getCanonicalIngredients: vi.fn(async () => [
    { id: 'chicken_breast', name: 'Chicken Breast', category: 'meat' },
    { id: 'yellow_onion', name: 'Yellow Onion', category: 'produce' },
    { id: 'baby_spinach', name: 'Baby Spinach', category: 'produce' },
  ]),
}));

import { mapProductNames } from '@/lib/normalization/mapper';

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('mapProductNames', () => {
  it('returns one mapping per input name, in order', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [
              { index: 0, canonical_id: 'chicken_breast', confidence: 0.95 },
              { index: 1, canonical_id: 'baby_spinach', confidence: 0.9 },
            ],
          },
        },
      ],
    });

    const result = await mapProductNames([
      'Kroger Boneless Skinless Chicken Breast',
      'Organic Baby Spinach',
    ]);

    expect(result).toEqual([
      { canonical_id: 'chicken_breast', confidence: 0.95 },
      { canonical_id: 'baby_spinach', confidence: 0.9 },
    ]);
  });

  it('returns null canonical_id when Haiku returns "unknown"', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'map_ingredients',
          input: {
            mappings: [{ index: 0, canonical_id: 'unknown', confidence: 0.2 }],
          },
        },
      ],
    });

    const result = await mapProductNames(['Weird Novelty Cheese Puff']);
    expect(result).toEqual([{ canonical_id: null, confidence: 0.2 }]);
  });

  it('fills gaps with null when Haiku omits an index', async () => {
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

    const result = await mapProductNames(['Chicken Breast', 'Missing Item']);
    expect(result[0]).toEqual({ canonical_id: 'chicken_breast', confidence: 0.9 });
    expect(result[1]).toEqual({ canonical_id: null, confidence: 0 });
  });

  it('batches inputs of 25 into two Haiku calls of 20 + 5', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'map_ingredients',
            input: {
              mappings: Array.from({ length: 20 }, (_, i) => ({
                index: i,
                canonical_id: 'chicken_breast',
                confidence: 0.9,
              })),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            name: 'map_ingredients',
            input: {
              mappings: Array.from({ length: 5 }, (_, i) => ({
                index: i,
                canonical_id: 'yellow_onion',
                confidence: 0.85,
              })),
            },
          },
        ],
      });

    const names = Array.from({ length: 25 }, (_, i) => `Item ${i}`);
    const result = await mapProductNames(names);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(25);
    expect(result[0].canonical_id).toBe('chicken_breast');
    expect(result[24].canonical_id).toBe('yellow_onion');
  });

  it('returns [] for empty input without calling Haiku', async () => {
    const result = await mapProductNames([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- tests/normalization/mapper.test.ts
```

Expected: FAIL — `mapper.ts` doesn't exist yet.

- [ ] **Step 3: Implement `lib/normalization/mapper.ts`**

Create `lib/normalization/mapper.ts`:

```typescript
import { getAnthropicClient } from '@/lib/anthropic/client';
import { getCanonicalIngredients } from './canonical';

export type Mapping = {
  canonical_id: string | null;
  confidence: number;
};

const BATCH_SIZE = 20;
const MODEL = 'claude-haiku-4-5-20251001';

const TOOL = {
  name: 'map_ingredients',
  description:
    "For each numbered product name, pick the single best matching canonical ingredient ID from the provided list. Return 'unknown' if no reasonable match exists. Confidence is 0.0 (guess) to 1.0 (certain).",
  input_schema: {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            canonical_id: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['index', 'canonical_id', 'confidence'],
        },
      },
    },
    required: ['mappings'],
  },
} as const;

export async function mapProductNames(names: string[]): Promise<Mapping[]> {
  if (names.length === 0) return [];
  const canonical = await getCanonicalIngredients();
  const client = getAnthropicClient();

  const results: Mapping[] = new Array(names.length).fill(null).map(() => ({
    canonical_id: null,
    confidence: 0,
  }));

  const canonicalListText = canonical
    .map((c) => `${c.id} — ${c.name}${c.category ? ` (${c.category})` : ''}`)
    .join('\n');

  for (let start = 0; start < names.length; start += BATCH_SIZE) {
    const batch = names.slice(start, start + BATCH_SIZE);
    const numbered = batch.map((n, i) => `${i}. ${n}`).join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [TOOL as any],
      tool_choice: { type: 'tool', name: 'map_ingredients' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Canonical ingredient list:\n${canonicalListText}`,
              // Cache the canonical list — it's static across every call in this run.
              cache_control: { type: 'ephemeral' },
            } as any,
            {
              type: 'text',
              text: `Map these product names:\n${numbered}`,
            },
          ],
        },
      ],
    });

    const toolUse = (response.content as any[]).find((b) => b.type === 'tool_use');
    if (!toolUse) continue;
    const mappings = (toolUse.input?.mappings ?? []) as Array<{
      index: number;
      canonical_id: string;
      confidence: number;
    }>;

    for (const m of mappings) {
      const globalIdx = start + m.index;
      if (globalIdx < 0 || globalIdx >= names.length) continue;
      const isUnknown = m.canonical_id === 'unknown' || m.canonical_id === '';
      results[globalIdx] = {
        canonical_id: isUnknown ? null : m.canonical_id,
        confidence: typeof m.confidence === 'number' ? m.confidence : 0,
      };
    }
  }

  return results;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- tests/normalization/mapper.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/normalization/mapper.ts tests/normalization/mapper.test.ts
git commit -m "Add Haiku-driven ingredient mapper with batching and prompt cache"
```

---

## Task 5: Mapping runner (TDD)

**Files:**
- Create: `lib/normalization/runner.ts`
- Test: `tests/normalization/runner.test.ts`

The runner queries `retailer_skus` for rows missing a mapping, calls `mapProductNames`, and writes `canonical_ingredient_id` + `mapping_confidence` back. Skips rows where `mapping_verified = true` (user has manually confirmed those).

- [ ] **Step 1: Write the failing test**

Create `tests/normalization/runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the mapper
const mockMap = vi.fn();
vi.mock('@/lib/normalization/mapper', () => ({
  mapProductNames: (names: string[]) => mockMap(names),
}));

// Mock the DB client
const mockUpsert = vi.fn(async () => ({ error: null }));
const mockSelect = vi.fn();
vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'retailer_skus') {
        return {
          select: () => ({
            is: () => ({ eq: () => mockSelect() }),
          }),
          upsert: mockUpsert,
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

beforeEach(() => {
  mockMap.mockReset();
  mockUpsert.mockReset().mockResolvedValue({ error: null });
  mockSelect.mockReset();
});

describe('runMappingForUnmappedSkus', () => {
  it('maps unmapped SKUs and writes canonical_ingredient_id + confidence', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [
        { id: 1, product_name: 'Chicken Breast' },
        { id: 2, product_name: 'Baby Spinach' },
      ],
      error: null,
    });
    mockMap.mockResolvedValueOnce([
      { canonical_id: 'chicken_breast', confidence: 0.95 },
      { canonical_id: 'baby_spinach', confidence: 0.9 },
    ]);

    const result = await runMappingForUnmappedSkus();

    expect(mockMap).toHaveBeenCalledWith(['Chicken Breast', 'Baby Spinach']);
    expect(mockUpsert).toHaveBeenCalledWith(
      [
        { id: 1, canonical_ingredient_id: 'chicken_breast', mapping_confidence: 0.95 },
        { id: 2, canonical_ingredient_id: 'baby_spinach', mapping_confidence: 0.9 },
      ],
      { onConflict: 'id' }
    );
    expect(result).toEqual({ mapped: 2, skipped: 0 });
  });

  it('skips rows where the mapper returned null canonical_id', async () => {
    mockSelect.mockResolvedValueOnce({
      data: [{ id: 3, product_name: 'Mystery Item' }],
      error: null,
    });
    mockMap.mockResolvedValueOnce([{ canonical_id: null, confidence: 0.1 }]);

    const result = await runMappingForUnmappedSkus();

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ mapped: 0, skipped: 1 });
  });

  it('returns 0/0 when no unmapped SKUs exist without calling the mapper', async () => {
    mockSelect.mockResolvedValueOnce({ data: [], error: null });

    const result = await runMappingForUnmappedSkus();

    expect(mockMap).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ mapped: 0, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- tests/normalization/runner.test.ts
```

Expected: FAIL — `runner.ts` doesn't exist.

- [ ] **Step 3: Implement `lib/normalization/runner.ts`**

Create `lib/normalization/runner.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';
import { mapProductNames } from './mapper';

export async function runMappingForUnmappedSkus(): Promise<{
  mapped: number;
  skipped: number;
}> {
  const supabase = getServerClient();

  // Fetch SKUs that have no mapping and haven't been manually verified.
  const { data, error } = await supabase
    .from('retailer_skus')
    .select('id, product_name')
    .is('canonical_ingredient_id', null)
    .eq('mapping_verified', false);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: number; product_name: string }>;
  if (rows.length === 0) return { mapped: 0, skipped: 0 };

  const mappings = await mapProductNames(rows.map((r) => r.product_name));

  const updates: Array<{
    id: number;
    canonical_ingredient_id: string;
    mapping_confidence: number;
  }> = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const m = mappings[i];
    if (!m || m.canonical_id === null) {
      skipped++;
      continue;
    }
    updates.push({
      id: rows[i].id,
      canonical_ingredient_id: m.canonical_id,
      mapping_confidence: m.confidence,
    });
  }

  if (updates.length > 0) {
    const { error: upErr } = await supabase
      .from('retailer_skus')
      .upsert(updates, { onConflict: 'id' });
    if (upErr) throw upErr;
  }

  return { mapped: updates.length, skipped };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- tests/normalization/runner.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/normalization/runner.ts tests/normalization/runner.test.ts
git commit -m "Add mapping runner: batch-map unmapped SKUs to canonical ingredients"
```

---

## Task 6: Refactor persist into a generic module

The current `lib/ingestion/harris-teeter/persist.ts` is retailer-specific. Refactor to `lib/ingestion/persist.ts` that takes a retailer name and generic store/deal input. This unblocks Sprouts (and later retailers) from reusing the same DB writes.

**Files:**
- Modify: `lib/ingestion/types.ts` (add generic `IngestionStore`)
- Create: `lib/ingestion/persist.ts`
- Delete: `lib/ingestion/harris-teeter/persist.ts`
- Modify: `app/api/admin/refresh-ht/route.ts`
- Modify: `lib/ingestion/harris-teeter/index.ts` (return `IngestionStore[]`)

- [ ] **Step 1: Add the generic store type**

Edit `lib/ingestion/types.ts` and append below the existing `NormalizedDeal` type:

```typescript
export type IngestionStore = {
  store_number: string;
  address: string | null;
  zip: string | null;
};

export type RetailerName = NormalizedDeal['retailer'];
```

- [ ] **Step 2: Create the generic persist**

Create `lib/ingestion/persist.ts`:

```typescript
import { getServerClient } from '@/lib/db/client';
import type { NormalizedDeal, IngestionStore, RetailerName } from './types';

function currentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

export async function persistDeals(input: {
  retailer: RetailerName;
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}): Promise<{ dealsUpserted: number }> {
  const supabase = getServerClient();

  const { data: retailerRow, error: rErr } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', input.retailer)
    .single();
  if (rErr || !retailerRow) throw new Error(`${input.retailer} retailer row missing`);
  const retailerId = retailerRow.id;

  // Upsert stores
  if (input.stores.length > 0) {
    const storeRows = input.stores.map((s) => ({
      retailer_id: retailerId,
      store_number: s.store_number,
      address: s.address,
      zip: s.zip,
      is_active: true,
    }));
    const { error: sErr } = await supabase
      .from('stores')
      .upsert(storeRows, { onConflict: 'retailer_id,store_number' });
    if (sErr) throw sErr;
  }

  // Reload store IDs
  const { data: storeIdRows, error: sIdErr } = await supabase
    .from('stores')
    .select('id, store_number')
    .eq('retailer_id', retailerId);
  if (sIdErr) throw sIdErr;
  const storeIdByNumber = new Map((storeIdRows ?? []).map((r) => [r.store_number, r.id]));

  if (input.deals.length === 0) {
    await touchHealth(supabase, retailerId, 'OK', null);
    return { dealsUpserted: 0 };
  }

  // Upsert retailer_skus (do NOT touch canonical_ingredient_id / mapping_* — those are managed
  // by the normalization runner. Upsert with ignoreDuplicates: false so product_name/image
  // stay fresh, but the mapping columns default to NULL/false only on INSERT.)
  const skuRows = input.deals.map((d) => ({
    retailer_id: retailerId,
    sku: d.sku,
    product_name: d.product_name,
    package_size: d.package_size,
    package_unit: d.package_unit,
    image_url: d.image_url,
  }));
  const { error: skuErr } = await supabase
    .from('retailer_skus')
    .upsert(skuRows, { onConflict: 'retailer_id,sku', ignoreDuplicates: false });
  if (skuErr) throw skuErr;

  // Reload SKU IDs
  const skus = input.deals.map((d) => d.sku);
  const { data: skuIdRows, error: skuIdErr } = await supabase
    .from('retailer_skus')
    .select('id, sku')
    .eq('retailer_id', retailerId)
    .in('sku', skus);
  if (skuIdErr) throw skuIdErr;
  const skuIdByCode = new Map((skuIdRows ?? []).map((r) => [r.sku, r.id]));

  // Upsert deals
  const weekOf = currentWeekOfISO();
  const dealRows = input.deals
    .map((d) => {
      const storeId = storeIdByNumber.get(d.store_number);
      const skuId = skuIdByCode.get(d.sku);
      if (!storeId || !skuId) return null;
      return {
        retailer_sku_id: skuId,
        store_id: storeId,
        week_of: weekOf,
        regular_price: d.regular_price,
        sale_price: d.sale_price,
        unit_price: null,
        valid_from: null,
        valid_until: null,
        source: d.source,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const { error: dErr } = await supabase
    .from('deals')
    .upsert(dealRows, { onConflict: 'retailer_sku_id,store_id,week_of' });
  if (dErr) throw dErr;

  await touchHealth(supabase, retailerId, 'OK', null);
  return { dealsUpserted: dealRows.length };
}

async function touchHealth(
  supabase: ReturnType<typeof getServerClient>,
  retailerId: number,
  status: 'OK' | 'DEGRADED' | 'FAILED',
  error: string | null
) {
  await supabase.from('retailer_health').upsert(
    {
      retailer_id: retailerId,
      last_success_at: status === 'OK' ? new Date().toISOString() : null,
      last_status: status,
      last_error: error,
    },
    { onConflict: 'retailer_id' }
  );
}
```

- [ ] **Step 3: Tighten HT return type**

Edit `lib/ingestion/harris-teeter/index.ts`. Change the return type from the HT-specific store shape to the generic one. Replace the function signature:

```typescript
export async function fetchHarrisTeeterDeals(zip: string): Promise<{
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}> {
```

And update the import at the top:

```typescript
import type { NormalizedDeal, IngestionStore } from '@/lib/ingestion/types';
```

Then update the return statement to map HTStore → IngestionStore (drop the `name` field):

```typescript
  return {
    stores: stores.map((s) => ({
      store_number: s.store_number,
      address: s.address,
      zip: s.zip,
    })),
    deals: allDeals,
  };
```

- [ ] **Step 4: Update the HT refresh route to use generic persist**

Replace `app/api/admin/refresh-ht/route.ts` with:

```typescript
import { NextResponse } from 'next/server';
import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { persistDeals } from '@/lib/ingestion/persist';

const ZIP = '21224';

export async function POST() {
  try {
    const result = await fetchHarrisTeeterDeals(ZIP);
    const persist = await persistDeals({
      retailer: 'harris-teeter',
      stores: result.stores,
      deals: result.deals,
    });
    return NextResponse.json({
      ok: true,
      stores: result.stores.length,
      dealsFetched: result.deals.length,
      dealsUpserted: persist.dealsUpserted,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 5: Delete the old HT-specific persist**

```bash
rm lib/ingestion/harris-teeter/persist.ts
```

- [ ] **Step 6: Run all existing tests to confirm nothing broke**

```bash
npm test
```

Expected: all previous tests still pass (17 pre-existing + 8 new normalization ones = 25 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/ingestion/types.ts lib/ingestion/persist.ts lib/ingestion/harris-teeter/index.ts app/api/admin/refresh-ht/route.ts lib/ingestion/harris-teeter/persist.ts
git commit -m "Extract persistDeals into retailer-agnostic module"
```

---

## Task 7: Wire mapping into the refresh flow + standalone endpoints

**Files:**
- Modify: `app/api/admin/refresh-ht/route.ts` (call mapping runner after persist)
- Create: `app/api/admin/map-unmapped/route.ts`
- Create: `scripts/map-unmapped.ts`
- Modify: `package.json` (add `map:unmapped` script)

**Vercel Hobby timeout caveat:** Wiring the mapping runner inline with refresh means a single HTTP request runs Kroger fetches + persist + Haiku mapping. Rough budget on the first run of the week: ~30s (Kroger) + ~30s (Haiku for ~200 fresh SKUs at 3s/batch × 10 batches) = ~60s, right at the Hobby function timeout. In normal steady-state weeks (~20 new SKUs), it's ~3s of Haiku and fine. If the first-of-week refresh times out, use `/api/admin/map-unmapped` as a fallback to finish the mapping (Task 12 Step 4 handles this).

- [ ] **Step 1: Trigger mapping after HT persist**

Edit `app/api/admin/refresh-ht/route.ts`. Add the import at the top:

```typescript
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';
```

Update the POST handler to call the runner after persist:

```typescript
export async function POST() {
  try {
    const result = await fetchHarrisTeeterDeals(ZIP);
    const persist = await persistDeals({
      retailer: 'harris-teeter',
      stores: result.stores,
      deals: result.deals,
    });
    const mapping = await runMappingForUnmappedSkus();
    return NextResponse.json({
      ok: true,
      stores: result.stores.length,
      dealsFetched: result.deals.length,
      dealsUpserted: persist.dealsUpserted,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create standalone mapping endpoint**

Create `app/api/admin/map-unmapped/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST() {
  try {
    const result = await runMappingForUnmappedSkus();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create CLI wrapper for local runs**

Create `scripts/map-unmapped.ts`:

```typescript
import 'dotenv/config';
import { runMappingForUnmappedSkus } from '../lib/normalization/runner';

async function main() {
  const result = await runMappingForUnmappedSkus();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Add npm script**

Edit `package.json` — add to the `scripts` block after the existing `seed` line:

```json
    "map:unmapped": "tsx scripts/map-unmapped.ts",
```

- [ ] **Step 5: Backfill existing HT SKUs locally**

```bash
npm run map:unmapped
```

Expected: JSON output like `{ "mapped": N, "skipped": M }`. Should take ~30 seconds if there are ~200 SKUs (10 Haiku calls × ~3s each).

Spot-check in Supabase Table Editor: `retailer_skus` should now have `canonical_ingredient_id` set for most rows.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/refresh-ht/route.ts app/api/admin/map-unmapped/route.ts scripts/map-unmapped.ts package.json
git commit -m "Wire mapping runner into HT refresh; add standalone map endpoint and CLI"
```

---

## Task 8: Flipp client (TDD)

**Files:**
- Create: `lib/ingestion/flipp/types.ts`
- Create: `lib/ingestion/flipp/client.ts`
- Create: `tests/ingestion/flipp/fixtures/search-response.json`
- Test: `tests/ingestion/flipp/client.test.ts`

**API shape verified against live `backflipp.wishabi.com` on 2026-07-27** with `curl 'https://backflipp.wishabi.com/flipp/items/search?locale=en-US&postal_code=21224&q=sprouts'`:

- Single endpoint returns everything: `merchants[]`, `items[]` (flyer items), `ecom_items[]`, `flyers[]`, `coupons[]`, etc.
- Merchant shape (no `slug` field): `{ id: 2419, name: "Sprouts Farmers Market", logo_url, country, store_locator_url, storefront_logo_url, us_based }`.
- Item shape (real fields — no `brand`, no `description`, no `price_text`, no `image_url`): `{ id, flyer_item_id, flyer_id, merchant_id, merchant_name, name, current_price, original_price, pre_price_text, post_price_text, sale_story, valid_from, valid_to, item_type ("flyer" | "ecom"), clean_image_url, clipping_image_url, brand_ids, _L1, _L2, item_weight, score, top, bottom, left, right, premium, indexed }`.
- **Keyword contamination:** `q=sprouts` returned 3 items from BJ's / Food Lion / Martin's Food Market (they matched "brussels sprouts" / "sprouted seeds"). The client MUST filter items to `merchant_id === merchant.id`.
- **Price reality:** for zip 21224 this week, 24/67 Sprouts items have a `current_price`, 43/67 are BOGO deals with only a `sale_story` and null prices.

Use a single client function that hits the search endpoint once and returns the merchant plus its items — no separate merchant-lookup + item-fetch calls.

- [ ] **Step 1: Add the response types**

Create `lib/ingestion/flipp/types.ts`:

```typescript
export type FlippMerchant = {
  id: number;
  name: string;
};

export type FlippItem = {
  id: number;
  flyer_item_id: number;
  flyer_id: number;
  merchant_id: number;
  merchant_name: string;
  name: string;
  item_type: string;
  current_price: number | null;
  original_price: number | null;
  pre_price_text: string | null;
  post_price_text: string | null;
  sale_story: string | null;
  valid_from: string | null;
  valid_to: string | null;
  clean_image_url: string | null;
  clipping_image_url: string | null;
};

export type FlippSearchResponse = {
  merchants: FlippMerchant[];
  items: FlippItem[];
};
```

- [ ] **Step 2: Add a fixture that mirrors the real response**

Create `tests/ingestion/flipp/fixtures/search-response.json`. Include a Sprouts merchant plus items with all three price-shape variants (concrete `current_price`, "N for $X" `sale_story`, BOGO with null price), plus one contaminating item from a different merchant to prove the filter works.

```json
{
  "merchants": [
    { "id": 2419, "name": "Sprouts Farmers Market" }
  ],
  "items": [
    {
      "id": 1026801989,
      "flyer_item_id": 1026801989,
      "flyer_id": 8032364,
      "merchant_id": 2419,
      "merchant_name": "Sprouts Farmers Market",
      "name": "Large Yellow or White Peaches",
      "item_type": "flyer",
      "current_price": 1.98,
      "original_price": null,
      "pre_price_text": null,
      "post_price_text": "/LB.",
      "sale_story": null,
      "valid_from": "2026-07-22T07:00:00+00:00",
      "valid_to": "2026-07-29T03:59:59+00:00",
      "clean_image_url": "https://f.wishabi.net/page_items/1/extra_large.jpg",
      "clipping_image_url": "https://f.wishabi.net/page_items/1/extra_large.jpg"
    },
    {
      "id": 1026801888,
      "flyer_item_id": 1026801888,
      "flyer_id": 8032364,
      "merchant_id": 2419,
      "merchant_name": "Sprouts Farmers Market",
      "name": "CVT Soft Serve Ice Cream",
      "item_type": "flyer",
      "current_price": 7,
      "original_price": null,
      "pre_price_text": "2 FOR",
      "post_price_text": null,
      "sale_story": null,
      "valid_from": "2026-07-22T07:00:00+00:00",
      "valid_to": "2026-07-29T03:59:59+00:00",
      "clean_image_url": null,
      "clipping_image_url": "https://f.wishabi.net/page_items/2/extra_large.jpg"
    },
    {
      "id": 1026801702,
      "flyer_item_id": 1026801702,
      "flyer_id": 8032364,
      "merchant_id": 2419,
      "merchant_name": "Sprouts Farmers Market",
      "name": "Sprouts Boneless Skinless Chicken Breasts",
      "item_type": "flyer",
      "current_price": null,
      "original_price": null,
      "pre_price_text": null,
      "post_price_text": null,
      "sale_story": "BUY ONE. GET ONE 50% OFF regular retail of equal or lesser value",
      "valid_from": "2026-07-22T07:00:00+00:00",
      "valid_to": "2026-07-29T03:59:59+00:00",
      "clean_image_url": null,
      "clipping_image_url": null
    },
    {
      "id": 999999,
      "flyer_item_id": 999999,
      "flyer_id": 111111,
      "merchant_id": 88,
      "merchant_name": "Food Lion",
      "name": "Food Lion Brussels Sprouts",
      "item_type": "flyer",
      "current_price": 2.49,
      "original_price": null,
      "pre_price_text": null,
      "post_price_text": null,
      "sale_story": null,
      "valid_from": "2026-07-22T07:00:00+00:00",
      "valid_to": "2026-07-29T03:59:59+00:00",
      "clean_image_url": null,
      "clipping_image_url": null
    }
  ]
}
```

- [ ] **Step 3: Write the failing test**

Create `tests/ingestion/flipp/client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../setup';
import { searchFlippMerchant } from '@/lib/ingestion/flipp/client';
import searchFixture from './fixtures/search-response.json';

describe('searchFlippMerchant', () => {
  it('sends postal_code and q, and returns the merchant plus its items only', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('locale')).toBe('en-US');
        expect(url.searchParams.get('postal_code')).toBe('21224');
        expect(url.searchParams.get('q')).toBe('Sprouts Farmers Market');
        return HttpResponse.json(searchFixture);
      })
    );

    const result = await searchFlippMerchant({
      zip: '21224',
      merchantName: 'Sprouts Farmers Market',
    });

    expect(result.merchant).toEqual({ id: 2419, name: 'Sprouts Farmers Market' });
    // Contaminating Food Lion item must be filtered out; 3 Sprouts items remain.
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.merchant_id).toBe(2419);
    }
  });

  it('picks the merchant by case-insensitive name match', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({
          merchants: [
            { id: 1, name: 'Other Store' },
            { id: 2419, name: 'Sprouts Farmers Market' },
          ],
          items: [],
        })
      )
    );

    const result = await searchFlippMerchant({
      zip: '21224',
      merchantName: 'sprouts farmers market',
    });
    expect(result.merchant?.id).toBe(2419);
  });

  it('returns { merchant: null, items: [] } when no merchant matches', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({ merchants: [], items: [] })
      )
    );

    const result = await searchFlippMerchant({
      zip: '99999',
      merchantName: 'Sprouts Farmers Market',
    });
    expect(result).toEqual({ merchant: null, items: [] });
  });

  it('throws on non-2xx responses', async () => {
    server.use(
      http.get('https://backflipp.wishabi.com/flipp/items/search', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 })
      )
    );

    await expect(
      searchFlippMerchant({ zip: '21224', merchantName: 'Sprouts Farmers Market' })
    ).rejects.toThrow(/Flipp search failed: 500/);
  });
});
```

- [ ] **Step 4: Run to verify failure**

```bash
npm test -- tests/ingestion/flipp/client.test.ts
```

Expected: FAIL — client doesn't exist.

- [ ] **Step 5: Implement `lib/ingestion/flipp/client.ts`**

Create `lib/ingestion/flipp/client.ts`:

```typescript
import type { FlippMerchant, FlippItem, FlippSearchResponse } from './types';

const BASE = 'https://backflipp.wishabi.com/flipp';

export async function searchFlippMerchant(input: {
  zip: string;
  merchantName: string;
}): Promise<{ merchant: FlippMerchant | null; items: FlippItem[] }> {
  const url = new URL(`${BASE}/items/search`);
  url.searchParams.set('locale', 'en-US');
  url.searchParams.set('postal_code', input.zip);
  url.searchParams.set('q', input.merchantName);

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Flipp search failed: ${res.status}`);
  const body = (await res.json()) as Partial<FlippSearchResponse>;

  const merchants = body.merchants ?? [];
  const wanted = input.merchantName.toLowerCase();
  const merchant =
    merchants.find((m) => m.name.toLowerCase() === wanted) ??
    merchants.find((m) => m.name.toLowerCase().includes(wanted)) ??
    null;

  if (!merchant) return { merchant: null, items: [] };

  const allItems = body.items ?? [];
  const items = allItems.filter((it) => it.merchant_id === merchant.id);
  return { merchant, items };
}
```

- [ ] **Step 6: Run to verify pass**

```bash
npm test -- tests/ingestion/flipp/client.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/ingestion/flipp tests/ingestion/flipp
git commit -m "Add Flipp client: single-endpoint merchant + item search"
```

---

## Task 9: Flipp normalizer (TDD)

**Files:**
- Create: `lib/ingestion/flipp/normalize.ts`
- Test: `tests/ingestion/flipp/normalize.test.ts`

Flipp items don't have a clean `regular_price` / `promo_price` split like Kroger. They have `current_price` (often null — 43/67 for Sprouts this week) and text fields like `sale_story` and `pre_price_text`. For MVP: treat `current_price` as `sale_price` if present; else try to parse "N for $X" from `sale_story`. Set `regular_price = null` — Flipp doesn't reliably expose it. Everything from Flipp is `on_sale = true` by definition (it's a weekly circular of promotions). Skip items with no parseable price (mostly BOGO deals like "BUY ONE. GET ONE 50% OFF") — those can't be represented as a per-unit price.

Note on `pre_price_text: "2 FOR"` + `current_price: 7`: the `current_price` in this case is the *total* for 2 units. Divide by the leading integer in `pre_price_text` to get a per-unit price. Applies to items like "CVT Soft Serve Ice Cream" (`pre_price_text: "2 FOR", current_price: 7` → `sale_price: 3.5`).

- [ ] **Step 1: Write the failing test**

Create `tests/ingestion/flipp/normalize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeFlippItems } from '@/lib/ingestion/flipp/normalize';
import type { FlippItem } from '@/lib/ingestion/flipp/types';

const base: FlippItem = {
  id: 100,
  flyer_item_id: 100,
  flyer_id: 8032364,
  merchant_id: 2419,
  merchant_name: 'Sprouts Farmers Market',
  name: 'Placeholder',
  item_type: 'flyer',
  current_price: null,
  original_price: null,
  pre_price_text: null,
  post_price_text: null,
  sale_story: null,
  valid_from: '2026-07-22T07:00:00+00:00',
  valid_to: '2026-07-29T03:59:59+00:00',
  clean_image_url: null,
  clipping_image_url: null,
};

describe('normalizeFlippItems', () => {
  it('converts a Flipp item with a concrete current_price', () => {
    const peaches: FlippItem = {
      ...base,
      flyer_item_id: 1026801989,
      name: 'Large Yellow or White Peaches',
      current_price: 1.98,
      post_price_text: '/LB.',
      clean_image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
      clipping_image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([peaches], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal).toMatchObject({
      retailer: 'sprouts',
      store_number: 'flipp-2419',
      sku: 'flipp-1026801989',
      product_name: 'Large Yellow or White Peaches',
      regular_price: null,
      sale_price: 1.98,
      on_sale: true,
      source: 'flipp',
      image_url: 'https://f.wishabi.net/page_items/1/extra_large.jpg',
    });
  });

  it('divides current_price by the quantity in "2 FOR" pre_price_text', () => {
    const iceCream: FlippItem = {
      ...base,
      flyer_item_id: 1026801888,
      name: 'CVT Soft Serve Ice Cream',
      current_price: 7,
      pre_price_text: '2 FOR',
      clipping_image_url: 'https://f.wishabi.net/page_items/2/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([iceCream], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(3.5);
  });

  it('parses "2 for $5" style sale_story when current_price is null', () => {
    const twoForFive: FlippItem = {
      ...base,
      flyer_item_id: 113,
      name: 'Two-for Special',
      sale_story: '2 for $5',
    };
    const [deal] = normalizeFlippItems([twoForFive], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(2.5);
  });

  it('parses a bare "$X" price from sale_story when current_price is null', () => {
    const bareDollar: FlippItem = {
      ...base,
      flyer_item_id: 115,
      name: 'Special Item',
      sale_story: 'Only $4.99 each!',
    };
    const [deal] = normalizeFlippItems([bareDollar], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.sale_price).toBe(4.99);
  });

  it('skips BOGO items with no parseable per-unit price', () => {
    const bogo: FlippItem = {
      ...base,
      flyer_item_id: 1026801702,
      name: 'Sprouts Boneless Skinless Chicken Breasts',
      sale_story: 'BUY ONE. GET ONE 50% OFF regular retail of equal or lesser value',
    };
    const result = normalizeFlippItems([bogo], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(result).toHaveLength(0);
  });

  it('prefers clean_image_url but falls back to clipping_image_url', () => {
    const onlyClipping: FlippItem = {
      ...base,
      flyer_item_id: 116,
      name: 'Clipping Only',
      current_price: 3.99,
      clean_image_url: null,
      clipping_image_url: 'https://f.wishabi.net/page_items/3/extra_large.jpg',
    };
    const [deal] = normalizeFlippItems([onlyClipping], {
      retailer: 'sprouts',
      storeNumber: 'flipp-2419',
    });
    expect(deal.image_url).toBe('https://f.wishabi.net/page_items/3/extra_large.jpg');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- tests/ingestion/flipp/normalize.test.ts
```

Expected: FAIL — normalizer doesn't exist.

- [ ] **Step 3: Implement `lib/ingestion/flipp/normalize.ts`**

Create `lib/ingestion/flipp/normalize.ts`:

```typescript
import type { NormalizedDeal, RetailerName } from '@/lib/ingestion/types';
import type { FlippItem } from './types';

const SINGLE_PRICE_RE = /\$([\d]+(?:\.[\d]+)?)/;
const N_FOR_PRICE_RE = /(\d+)\s*for\s*\$([\d]+(?:\.[\d]+)?)/i;
const LEADING_QTY_RE = /^\s*(\d+)\b/;

function parsePrice(item: FlippItem): number | null {
  // "N FOR" bundle price: current_price is the total for N units.
  if (item.current_price != null && item.current_price > 0 && item.pre_price_text) {
    const qtyMatch = item.pre_price_text.match(LEADING_QTY_RE);
    if (qtyMatch) {
      const qty = parseInt(qtyMatch[1], 10);
      if (qty > 1) return Math.round((item.current_price / qty) * 100) / 100;
    }
  }
  if (item.current_price != null && item.current_price > 0) return item.current_price;

  // Fall back to parsing sale_story for "N for $X" or bare "$X".
  const text = item.sale_story;
  if (!text) return null;
  const nFor = text.match(N_FOR_PRICE_RE);
  if (nFor) {
    const qty = parseInt(nFor[1], 10);
    const total = parseFloat(nFor[2]);
    if (qty > 0 && total > 0) return Math.round((total / qty) * 100) / 100;
  }
  const single = text.match(SINGLE_PRICE_RE);
  if (single) return parseFloat(single[1]);
  return null;
}

export function normalizeFlippItems(
  items: FlippItem[],
  ctx: { retailer: RetailerName; storeNumber: string }
): NormalizedDeal[] {
  const deals: NormalizedDeal[] = [];
  for (const it of items) {
    const price = parsePrice(it);
    if (price === null) continue;
    deals.push({
      retailer: ctx.retailer,
      store_number: ctx.storeNumber,
      sku: `flipp-${it.flyer_item_id}`,
      product_name: it.name,
      package_size: null,
      package_unit: null,
      image_url: it.clean_image_url ?? it.clipping_image_url ?? null,
      regular_price: null,
      sale_price: price,
      on_sale: true,
      source: 'flipp',
    });
  }
  return deals;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- tests/ingestion/flipp/normalize.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ingestion/flipp/normalize.ts tests/ingestion/flipp/normalize.test.ts
git commit -m "Add Flipp normalizer: parse from current_price, pre_price_text, sale_story"
```

---

## Task 10: Sprouts orchestrator (TDD)

**Files:**
- Create: `lib/ingestion/sprouts/index.ts`
- Test: `tests/ingestion/sprouts/index.test.ts`

The orchestrator makes a single call to `searchFlippMerchant` (Task 8) with `merchantName: 'Sprouts Farmers Market'` and passes the items to `normalizeFlippItems` (Task 9). Flipp doesn't return physical store data, so synthesize a single per-zip store record: `store_number = "flipp-<merchant_id>"`, `address = null`, `zip = <input zip>`.

- [ ] **Step 1: Write the failing test**

Create `tests/ingestion/sprouts/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
vi.mock('@/lib/ingestion/flipp/client', () => ({
  searchFlippMerchant: (input: any) => mockSearch(input),
}));

import { fetchSproutsDeals } from '@/lib/ingestion/sprouts';

beforeEach(() => {
  mockSearch.mockReset();
});

describe('fetchSproutsDeals', () => {
  it('returns a synthesized store and normalized deals when Sprouts is found', async () => {
    mockSearch.mockResolvedValueOnce({
      merchant: { id: 2419, name: 'Sprouts Farmers Market' },
      items: [
        {
          id: 1026801989,
          flyer_item_id: 1026801989,
          flyer_id: 8032364,
          merchant_id: 2419,
          merchant_name: 'Sprouts Farmers Market',
          name: 'Large Yellow or White Peaches',
          item_type: 'flyer',
          current_price: 1.98,
          original_price: null,
          pre_price_text: null,
          post_price_text: '/LB.',
          sale_story: null,
          valid_from: null,
          valid_to: null,
          clean_image_url: null,
          clipping_image_url: null,
        },
      ],
    });

    const result = await fetchSproutsDeals('21224');
    expect(mockSearch).toHaveBeenCalledWith({
      zip: '21224',
      merchantName: 'Sprouts Farmers Market',
    });
    expect(result.stores).toEqual([
      { store_number: 'flipp-2419', address: null, zip: '21224' },
    ]);
    expect(result.deals).toHaveLength(1);
    expect(result.deals[0]).toMatchObject({
      retailer: 'sprouts',
      store_number: 'flipp-2419',
      sale_price: 1.98,
    });
  });

  it('returns empty result when no Sprouts merchant found for the zip', async () => {
    mockSearch.mockResolvedValueOnce({ merchant: null, items: [] });
    const result = await fetchSproutsDeals('99999');
    expect(result.stores).toEqual([]);
    expect(result.deals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- tests/ingestion/sprouts/index.test.ts
```

Expected: FAIL — sprouts module doesn't exist.

- [ ] **Step 3: Implement `lib/ingestion/sprouts/index.ts`**

Create `lib/ingestion/sprouts/index.ts`:

```typescript
import { searchFlippMerchant } from '@/lib/ingestion/flipp/client';
import { normalizeFlippItems } from '@/lib/ingestion/flipp/normalize';
import type { NormalizedDeal, IngestionStore } from '@/lib/ingestion/types';

export async function fetchSproutsDeals(zip: string): Promise<{
  stores: IngestionStore[];
  deals: NormalizedDeal[];
}> {
  const { merchant, items } = await searchFlippMerchant({
    zip,
    merchantName: 'Sprouts Farmers Market',
  });
  if (!merchant) return { stores: [], deals: [] };

  const storeNumber = `flipp-${merchant.id}`;
  const deals = normalizeFlippItems(items, { retailer: 'sprouts', storeNumber });

  return {
    stores: [{ store_number: storeNumber, address: null, zip }],
    deals,
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- tests/ingestion/sprouts/index.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ingestion/sprouts tests/ingestion/sprouts
git commit -m "Add Sprouts orchestrator: Flipp-only ingestion"
```

---

## Task 11: Sprouts refresh endpoint

**Files:**
- Create: `app/api/admin/refresh-sprouts/route.ts`

- [ ] **Step 1: Create the endpoint**

Create `app/api/admin/refresh-sprouts/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { fetchSproutsDeals } from '@/lib/ingestion/sprouts';
import { persistDeals } from '@/lib/ingestion/persist';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

const ZIP = '21224';

export async function POST() {
  try {
    const result = await fetchSproutsDeals(ZIP);
    const persist = await persistDeals({
      retailer: 'sprouts',
      stores: result.stores,
      deals: result.deals,
    });
    const mapping = await runMappingForUnmappedSkus();
    return NextResponse.json({
      ok: true,
      stores: result.stores.length,
      dealsFetched: result.deals.length,
      dealsUpserted: persist.dealsUpserted,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manually trigger locally**

Start the dev server if not already running:

```bash
npm run dev
```

Then in a logged-in browser session at http://localhost:3000, open the browser console:

```js
await fetch('/api/admin/refresh-sprouts', { method: 'POST' }).then(r => r.json())
```

Expected: `{ ok: true, stores: 1, dealsFetched: <N>, dealsUpserted: <N>, skusMapped: <M>, skusSkipped: <K> }`.

Refresh the home page — Sprouts deals should now appear alongside HT deals (the `lib/deals/read.ts` reader already joins by retailer name).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/refresh-sprouts/route.ts
git commit -m "Add dev endpoint to refresh Sprouts deals via Flipp"
```

---

## Task 12: Deploy and verify in production

- [ ] **Step 1: Confirm all tests pass**

```bash
npm test
```

Expected: PASS across all files. New total: 17 pre-existing + 8 normalization + 4 flipp client + 4 flipp normalize + 2 sprouts = 35 tests.

- [ ] **Step 2: Push to trigger Vercel auto-deploy**

```bash
git push
```

- [ ] **Step 3: Wait for Vercel build**

```bash
vercel ls
```

Expected: latest deploy transitions from `Building` → `Ready` in ~35–60s. If it fails, `vercel logs <deployment-url>` for the error.

- [ ] **Step 4: Trigger production refresh for HT (re-run with mapping wired in)**

In a logged-in browser session at https://grocery-planner-omega.vercel.app, open the console:

```js
await fetch('/api/admin/refresh-ht', { method: 'POST' }).then(r => r.json())
```

Expected: `skusMapped > 0` for the first run (production DB previously had HT SKUs with no mappings).

**If the request times out (Vercel Hobby 60s limit):** the persist likely succeeded but the mapping step didn't finish. Run the standalone mapping endpoint to complete it:

```js
await fetch('/api/admin/map-unmapped', { method: 'POST' }).then(r => r.json())
```

Repeat if needed until `mapped: 0` is returned.

- [ ] **Step 5: Trigger production refresh for Sprouts**

```js
await fetch('/api/admin/refresh-sprouts', { method: 'POST' }).then(r => r.json())
```

Expected: `stores: 1, dealsFetched > 0`.

- [ ] **Step 6: Verify on the home page**

Refresh the home page. Expected:
- Deals from both `harris-teeter` and `sprouts` appear
- Deals are sorted by `sale_price` ascending (existing behavior)

- [ ] **Step 7: Spot-check Supabase**

In the Supabase Table Editor:
- `retailer_skus` — the majority of rows have `canonical_ingredient_id` populated and `mapping_confidence` between ~0.5 and 1.0
- `stores` — has one Sprouts row (`store_number: flipp-<id>`)
- `deals` — has rows with `source: 'flipp'` and `retailer_sku_id` pointing to Sprouts SKUs
- `retailer_health` — has `last_status: 'OK'` for both HT and Sprouts

If any of the above fails, don't move on to Week 2b — fix first.

---

## Week 2a done. Verify:

- [ ] Local `npm run test` — all tests pass (target ≥ 35)
- [ ] Home page renders Sprouts deals alongside HT deals in production
- [ ] `retailer_skus.canonical_ingredient_id` is populated for the majority of HT + Sprouts SKUs
- [ ] Mapping confidence values look reasonable (spot-check 10 rows: obvious matches like "Chicken Breast" → `chicken_breast` should have confidence ≥ 0.8)
- [ ] Repeated calls to `/api/admin/map-unmapped` return `{ mapped: 0, skipped: <same-K-as-before> }` (i.e. it's idempotent — no re-mapping of already-mapped rows)

Week 2b (Target Redsky) can proceed once these all pass.

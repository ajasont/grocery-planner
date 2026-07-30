import { getServerClient } from '@/lib/db/client';
import { getCurrentWeekOfISO } from '@/lib/dates';

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

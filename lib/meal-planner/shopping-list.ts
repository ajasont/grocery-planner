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
    canonicalName: string;
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
    // Deals can name a group member that no meal in this plan uses (e.g., penne
    // on sale but this week only cooks spaghetti). Register the name so the
    // "cheapest: X" recommendation can still show a specific shape. The
    // ingredient-supplied name (from earlier) wins if both sources have one.
    const agg = byGroup.get(key);
    if (agg && !agg.memberIdToName.has(d.canonicalId)) {
      agg.memberIdToName.set(d.canonicalId, d.canonicalName);
    }
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

export type PlanRow = {
  id: number;
  week_of: string;
  pantry_canonical_ingredient_ids: string[] | null;
};

export async function buildShoppingList(plan: PlanRow): Promise<ShoppingList> {
  const supabase = getServerClient();
  const planId = plan.id;
  const weekOf = plan.week_of;

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
      canonical_ingredients: { name: string; shopping_group: string | null } | null;
      retailers: { name: string };
    };
  };

  // 2–5. Ingredients, deals, checks, and live pantry are all independent — fetch in parallel.
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
           canonical_ingredients (name, shopping_group),
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
      shoppingGroup: ing.canonical_ingredients?.shopping_group ?? null,
      quantity: ing.quantity,
      unit: ing.unit,
      mealName: meal.name,
      mealDay: meal.day,
    }))
  );

  const deals = ((dealRows ?? []) as unknown as DealRow[])
    .filter((r) => r.retailer_skus.canonical_ingredient_id !== null)
    .map((r) => ({
      canonicalId: r.retailer_skus.canonical_ingredient_id as string,
      canonicalName:
        r.retailer_skus.canonical_ingredients?.name ??
        (r.retailer_skus.canonical_ingredient_id as string),
      shoppingGroup: r.retailer_skus.canonical_ingredients?.shopping_group ?? null,
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

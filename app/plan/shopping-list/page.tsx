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

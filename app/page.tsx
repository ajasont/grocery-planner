import Link from 'next/link';
import { getCurrentWeekOnSaleDeals } from '@/lib/deals/read';
import { getRetailerDisplayName } from '@/lib/retailers/display';
import { getCurrentWeekPlan } from '@/lib/meal-planner/read';

export const dynamic = 'force-dynamic';

function formatPrice(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export default async function HomePage() {
  const [groups, plan] = await Promise.all([
    getCurrentWeekOnSaleDeals(),
    getCurrentWeekPlan(),
  ]);

  return (
    <main>
      <section className="mb-6">
        <h2 className="text-lg font-semibold">This Week&apos;s Deals</h2>
        <p className="text-sm text-neutral-500">
          {groups.length > 0
            ? `${groups.length} deals on sale`
            : 'No deals loaded yet. Trigger a refresh via /api/admin/refresh-ht or /api/admin/refresh-sprouts.'}
        </p>
      </section>
      {!plan && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          No plan for this week yet —{' '}
          <Link href="/plan" className="font-medium underline">
            plan it →
          </Link>
        </div>
      )}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {groups.map((g) => {
          const primary = g.canonical_name ?? g.sample_product_name;
          const showSecondary = g.canonical_name !== null;
          return (
            <li
              key={g.key}
              className="flex items-start gap-3 rounded border bg-white p-3 shadow-sm"
            >
              {g.sample_image_url && (
                <img
                  src={g.sample_image_url}
                  alt=""
                  className="h-14 w-14 rounded object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-medium">{primary}</p>
                  {g.variant_count > 1 && (
                    <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                      {g.variant_count} varieties
                    </span>
                  )}
                </div>
                {showSecondary && (
                  <p className="truncate text-xs text-neutral-400">
                    e.g. {g.sample_product_name}
                  </p>
                )}
                <p className="text-xs text-neutral-500">
                  {getRetailerDisplayName(g.retailer_name)}
                </p>
                <p className="mt-1 text-sm">
                  <span className="font-semibold text-green-700">
                    {formatPrice(g.sale_price)}
                  </span>
                  {g.regular_price !== null && g.sale_price !== null && (
                    <span className="ml-2 text-neutral-400 line-through">
                      {formatPrice(g.regular_price)}
                    </span>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

import { getCurrentWeekOnSaleDeals } from '@/lib/deals/read';

export const dynamic = 'force-dynamic';

function formatPrice(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export default async function HomePage() {
  const deals = await getCurrentWeekOnSaleDeals();

  return (
    <main>
      <section className="mb-6">
        <h2 className="text-lg font-semibold">This Week&apos;s Deals</h2>
        <p className="text-sm text-neutral-500">
          {deals.length > 0
            ? `${deals.length} items on sale`
            : 'No deals loaded yet. Trigger a refresh via /api/admin/refresh-ht.'}
        </p>
      </section>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {deals.map((d, i) => (
          <li
            key={i}
            className="flex items-start gap-3 rounded border bg-white p-3 shadow-sm"
          >
            {d.image_url && (
              <img
                src={d.image_url}
                alt=""
                className="h-14 w-14 rounded object-cover"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium">{d.product_name}</p>
              <p className="text-xs text-neutral-500 capitalize">{d.retailer_name}</p>
              <p className="mt-1 text-sm">
                <span className="font-semibold text-green-700">
                  {formatPrice(d.sale_price)}
                </span>
                {d.regular_price !== null && d.sale_price !== null && (
                  <span className="ml-2 text-neutral-400 line-through">
                    {formatPrice(d.regular_price)}
                  </span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

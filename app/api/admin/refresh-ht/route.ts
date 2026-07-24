import { NextResponse } from 'next/server';
import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { persistHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter/persist';

const ZIP = '21224';

export async function POST() {
  try {
    const result = await fetchHarrisTeeterDeals(ZIP);
    const persist = await persistHarrisTeeterDeals(result);
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

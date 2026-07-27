import { NextResponse } from 'next/server';
import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { persistDeals } from '@/lib/ingestion/persist';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

const ZIP = '21224';

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

import { NextResponse } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST() {
  const result = await refreshRetailer('sprouts');
  try {
    const mapping = await runMappingForUnmappedSkus();
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
    });
  } catch (err) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: 0,
      skusSkipped: 0,
      mapperError: err instanceof Error ? err.message : String(err),
    });
  }
}

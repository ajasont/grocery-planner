import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST(req: NextRequest) {
  const result = await refreshRetailer('sprouts');
  let mapping = { mapped: 0, skipped: 0 };
  let mapperError: string | null = null;
  try {
    const m = await runMappingForUnmappedSkus();
    mapping = { mapped: m.mapped, skipped: m.skipped };
  } catch (err) {
    mapperError = err instanceof Error ? err.message : String(err);
  }

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json')) {
    return NextResponse.json({
      ok: result.status === 'OK',
      ...result,
      skusMapped: mapping.mapped,
      skusSkipped: mapping.skipped,
      ...(mapperError !== null ? { mapperError } : {}),
    });
  }
  return NextResponse.redirect(new URL('/health', req.url), 303);
}

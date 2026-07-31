import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer, type RefreshResult } from '@/lib/ingestion/refresh';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

const RETAILERS = ['harris-teeter', 'sprouts'] as const;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  const settled = await Promise.allSettled(
    RETAILERS.map((r) => refreshRetailer(r))
  );
  const results: RefreshResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          retailer: RETAILERS[i],
          status: 'FAILED',
          dealsFetched: 0,
          dealsUpserted: 0,
          error:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
        }
  );

  let mapper: { mapped: number; skipped: number; error: string | null };
  try {
    const m = await runMappingForUnmappedSkus();
    mapper = { mapped: m.mapped, skipped: m.skipped, error: null };
  } catch (err) {
    mapper = {
      mapped: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return NextResponse.json({
    runAt: new Date().toISOString(),
    results,
    mapper,
  });
}

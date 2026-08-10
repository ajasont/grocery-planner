import { NextResponse, type NextRequest } from 'next/server';
import { refreshRetailer, type RefreshResult } from '@/lib/ingestion/refresh';
import { runClassificationForUnclassifiedFlippSkus } from '@/lib/normalization/classifier-runner';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';
import { getServerClient } from '@/lib/db/client';

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

  // Classifier runs before the mapper so bad rows are gated out of the mapper's select.
  // Failure here does NOT abort the mapper — recorded in job_runs and surfaced on /health.
  let classifier: {
    classified: number;
    flagged: number;
    failed: number;
    error: string | null;
  };
  try {
    const c = await runClassificationForUnclassifiedFlippSkus();
    classifier = {
      classified: c.classified,
      flagged: c.flagged,
      failed: c.failed,
      error: null,
    };
  } catch (err) {
    classifier = {
      classified: 0,
      flagged: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let mapper: {
    mapped: number;
    skipped: number;
    failed: number;
    error: string | null;
  };
  try {
    const m = await runMappingForUnmappedSkus();
    mapper = { mapped: m.mapped, skipped: m.skipped, failed: m.failed, error: null };
  } catch (err) {
    mapper = {
      mapped: 0,
      skipped: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort append to job_runs. A failed write here does not mask the
  // real result: the caller and Vercel logs still show the response envelope.
  // Divergence detection on /health surfaces silent write failures.
  try {
    const supabase = getServerClient();
    const { error } = await supabase.from('job_runs').insert({
      classifier_status: classifier.error === null ? 'OK' : 'FAILED',
      classifier_classified: classifier.classified,
      classifier_flagged: classifier.flagged,
      classifier_failed: classifier.failed,
      classifier_error: classifier.error,
      mapper_status: mapper.error === null ? 'OK' : 'FAILED',
      mapper_mapped: mapper.mapped,
      mapper_skipped: mapper.skipped,
      mapper_failed: mapper.failed,
      mapper_error: mapper.error,
    });
    if (error) {
      console.warn('job_runs insert failed:', error.message);
    }
  } catch (err) {
    console.warn(
      'job_runs insert threw:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return NextResponse.json({
    runAt: new Date().toISOString(),
    results,
    classifier,
    mapper,
  });
}

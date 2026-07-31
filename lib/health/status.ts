import { getServerClient } from '@/lib/db/client';
// Type-only import: at runtime the refresh module (and its retailer fetchers)
// does not execute, so status tests don't need to mock those modules.
import type { RefreshRetailerName } from '@/lib/ingestion/refresh';

export const STALE_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;

const DISPLAY_NAMES: Record<RefreshRetailerName, string> = {
  'harris-teeter': 'Harris Teeter',
  sprouts: 'Sprouts',
};

const RETAILER_ORDER: RefreshRetailerName[] = ['harris-teeter', 'sprouts'];

export type RetailerHealthStatus = 'OK' | 'FAILED' | 'STALE' | 'NEVER';

export type RetailerStatus = {
  name: RefreshRetailerName;
  displayName: string;
  status: RetailerHealthStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type MapperStatus = {
  runAt: string;
  status: 'OK' | 'FAILED';
  mapped: number;
  skipped: number;
  failed: number;
  error: string | null;
};

export type HealthSnapshot = {
  hasProblem: boolean;
  retailers: RetailerStatus[];
  mapper: MapperStatus | null;
  history: MapperStatus[];
};

type RetailerHealthJoinRow = {
  last_success_at: string | null;
  last_status: 'OK' | 'FAILED' | 'DEGRADED' | null;
  last_error: string | null;
  retailers: { name: string } | null;
};

type JobRunRow = {
  run_at: string;
  mapper_status: 'OK' | 'FAILED';
  mapper_mapped: number;
  mapper_skipped: number;
  mapper_failed: number;
  mapper_error: string | null;
};

function classifyRetailer(
  name: RefreshRetailerName,
  row: RetailerHealthJoinRow | undefined,
  now: number
): RetailerStatus {
  if (!row) {
    return {
      name,
      displayName: DISPLAY_NAMES[name],
      status: 'NEVER',
      lastSuccessAt: null,
      lastError: null,
    };
  }
  const lastSuccessAt = row.last_success_at;
  const lastStatus = row.last_status;
  let status: RetailerHealthStatus;
  if (lastStatus === 'FAILED') {
    status = 'FAILED';
  } else if (lastSuccessAt === null) {
    // OK/DEGRADED/null status but no timestamp — treat as STALE.
    status = 'STALE';
  } else {
    const ageMs = now - new Date(lastSuccessAt).getTime();
    status = ageMs > STALE_THRESHOLD_MS ? 'STALE' : 'OK';
  }
  return {
    name,
    displayName: DISPLAY_NAMES[name],
    status,
    lastSuccessAt,
    lastError: row.last_error,
  };
}

function toMapperStatus(row: JobRunRow): MapperStatus {
  return {
    runAt: row.run_at,
    status: row.mapper_status,
    mapped: row.mapper_mapped,
    skipped: row.mapper_skipped,
    failed: row.mapper_failed,
    error: row.mapper_error,
  };
}

export async function computeHealth(): Promise<HealthSnapshot> {
  const supabase = getServerClient();

  // Read retailer_health joined with retailers so we get the retailer name inline.
  // Supabase-js JOIN syntax: select('col, ..., retailers(name)').
  const healthRes = (await supabase
    .from('retailer_health')
    .select(
      'last_success_at, last_status, last_error, retailers ( name )'
    )) as { data: RetailerHealthJoinRow[] | null; error: unknown };
  if (healthRes.error) throw healthRes.error;
  const healthRows = healthRes.data ?? [];

  // Read the newest 5 job_runs; the top row is `mapper`, next 4 are `history`.
  const jobRunsRes = (await supabase
    .from('job_runs')
    .select(
      'run_at, mapper_status, mapper_mapped, mapper_skipped, mapper_failed, mapper_error'
    )
    .order('run_at', { ascending: false })
    .limit(5)) as { data: JobRunRow[] | null; error: unknown };
  if (jobRunsRes.error) throw jobRunsRes.error;
  const jobRunRows = jobRunsRes.data ?? [];

  const byName = new Map<string, RetailerHealthJoinRow>();
  for (const r of healthRows) {
    const n = r.retailers?.name;
    if (n) byName.set(n, r);
  }

  const now = Date.now();
  const retailers = RETAILER_ORDER.map((name) =>
    classifyRetailer(name, byName.get(name), now)
  );

  const mapper = jobRunRows.length > 0 ? toMapperStatus(jobRunRows[0]) : null;
  const history = jobRunRows.slice(1).map(toMapperStatus);

  const hasProblem =
    retailers.some((r) => r.status !== 'OK') ||
    (mapper !== null && mapper.status === 'FAILED');

  return { hasProblem, retailers, mapper, history };
}

import Link from 'next/link';
import { computeHealth } from '@/lib/health/status';
import type { RetailerStatus, MapperStatus } from '@/lib/health/status';

export const dynamic = 'force-dynamic';

function fmtWhen(iso: string | null): string {
  if (iso === null) return 'never';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const hours = Math.round(diffMs / (60 * 60 * 1000));
  if (Math.abs(hours) < 48) return rtf.format(-hours, 'hour');
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  return rtf.format(-days, 'day');
}

function fmtRunAt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
}

function statusColor(status: RetailerStatus['status']): string {
  switch (status) {
    case 'OK':
      return 'text-green-700';
    case 'STALE':
      return 'text-amber-700';
    case 'FAILED':
    case 'NEVER':
      return 'text-red-700';
  }
}

function retryAction(name: RetailerStatus['name']): string {
  return name === 'harris-teeter'
    ? '/api/admin/refresh-ht'
    : '/api/admin/refresh-sprouts';
}

function RetailerCard({ r }: { r: RetailerStatus }) {
  return (
    <div className="rounded border p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{r.displayName}</p>
          <p className={`text-sm ${statusColor(r.status)}`}>
            {r.status} — last success: {fmtWhen(r.lastSuccessAt)}
          </p>
          {r.lastError && (
            <p className="mt-1 text-xs text-red-700">Error: {r.lastError}</p>
          )}
        </div>
        <form action={retryAction(r.name)} method="POST">
          <button
            type="submit"
            aria-label={`Retry ${r.displayName}`}
            className="rounded border px-3 py-1 text-sm hover:bg-neutral-50"
          >
            Retry
          </button>
        </form>
      </div>
    </div>
  );
}

function MapperCard({ m }: { m: MapperStatus }) {
  return (
    <div className="rounded border p-3">
      <p className="font-medium">Mapper — last run</p>
      <p className={`text-sm ${m.status === 'OK' ? 'text-green-700' : 'text-red-700'}`}>
        {fmtRunAt(m.runAt)} — {m.status} — {m.mapped} mapped / {m.skipped} skipped / {m.failed} failed
      </p>
      {m.error && <p className="mt-1 text-xs text-red-700">Error: {m.error}</p>}
    </div>
  );
}

export default async function HealthPage() {
  const health = await computeHealth();
  const overall = health.hasProblem ? 'Refresh problem detected' : 'All systems healthy';
  const overallClass = health.hasProblem
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-green-200 bg-green-50 text-green-700';

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
        <Link href="/pantry" className="text-sm text-blue-600 hover:underline">
          Pantry →
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Health</h1>
        <div
          role={health.hasProblem ? 'alert' : 'status'}
          className={`mt-2 rounded border p-3 text-sm font-medium ${overallClass}`}
        >
          {overall}
        </div>
      </header>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Retailers</h2>
        <div className="space-y-2">
          {health.retailers.map((r) => (
            <RetailerCard key={r.name} r={r} />
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Mapper</h2>
        {health.mapperHistoryStale && (
          <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">Mapper history missing</p>
            <p>
              A retailer refresh landed but no job_runs row was written. The
              write is best-effort — check that the <code>job_runs</code> table
              exists in Supabase.
            </p>
          </div>
        )}
        {health.mapper === null ? (
          <p className="text-sm text-neutral-500">
            No runs yet. First scheduled run: Sunday 14:00 UTC.
          </p>
        ) : (
          <MapperCard m={health.mapper} />
        )}
      </section>

      {health.history.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Recent runs</h2>
          <ul className="divide-y rounded border">
            {health.history.map((m) => (
              <li key={m.runAt} className="p-2 text-sm">
                <span className="font-mono text-neutral-500">{fmtRunAt(m.runAt)}</span>
                {' — '}
                <span className={m.status === 'OK' ? 'text-green-700' : 'text-red-700'}>
                  {m.status}
                </span>
                {' — '}
                {m.mapped} / {m.skipped} / {m.failed}
                {m.error && <span className="text-red-700"> — {m.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

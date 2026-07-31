import Link from 'next/link';
import type { HealthSnapshot } from '@/lib/health/status';


function bannerMessage(health: HealthSnapshot): string {
  const problemRetailers = health.retailers.filter((r) => r.status !== 'OK');
  const mapperFailed =
    health.mapper !== null && health.mapper.status === 'FAILED';

  const problemCount = problemRetailers.length + (mapperFailed ? 1 : 0);

  if (problemCount >= 2) {
    return 'Refresh problems detected';
  }

  if (problemRetailers.length === 1) {
    const r = problemRetailers[0];
    if (r.status === 'FAILED') {
      return `Sunday refresh failed for ${r.displayName}`;
    }
    if (r.status === 'STALE') {
      const days =
        r.lastSuccessAt !== null
          ? Math.floor(
              (Date.now() - new Date(r.lastSuccessAt).getTime()) /
                (24 * 60 * 60 * 1000)
            )
          : null;
      return days !== null
        ? `No refresh in ${days} days for ${r.displayName}`
        : `No refresh yet for ${r.displayName}`;
    }
    if (r.status === 'NEVER') {
      return `No refresh yet for ${r.displayName}`;
    }
  }

  if (mapperFailed) {
    return 'Ingredient mapping failed on last refresh';
  }

  return 'Refresh problem detected';
}

export function HealthBanner({ health }: { health: HealthSnapshot }) {
  const message = bannerMessage(health);
  return (
    <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p className="font-medium">
        {message} —{' '}
        <Link href="/health" className="underline hover:no-underline">
          view health
        </Link>
      </p>
    </div>
  );
}

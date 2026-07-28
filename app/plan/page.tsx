import Link from 'next/link';
import { getCurrentWeekPlan } from '@/lib/meal-planner/read';
import { DayAccordion } from './DayAccordion';
import { RegenerateButton } from './RegenerateButton';
import type { Day } from '@/lib/meal-planner/types';

export const dynamic = 'force-dynamic';

const ERROR_COPY: Record<string, string> = {
  anthropic: 'Planner service unavailable. Please try again.',
  json: 'Planner returned an unreadable response. Please try again.',
  schema: 'Planner returned a badly-shaped plan. Please try again.',
  sanity: 'Planner returned an invalid plan (missing ingredients or bad cook time). Please try again.',
  variety: 'Planner could not vary cuisines enough. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

function todayName(): Day {
  const names: Day[] = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  return names[new Date().getUTCDay()];
}

function ErrorBanner({ kind }: { kind: string }) {
  const message = ERROR_COPY[kind] ?? ERROR_COPY.unknown;
  return (
    <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p className="font-medium">Generation failed</p>
      <p>{message}</p>
    </div>
  );
}

function GenerateForm({ label }: { label: string }) {
  return (
    <form action="/api/plan/generate" method="POST">
      <button
        type="submit"
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
      >
        {label}
      </button>
    </form>
  );
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const plan = await getCurrentWeekPlan();
  const errorKind = searchParams.error;

  if (!plan) {
    return (
      <main>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">This week&apos;s plan</h2>
          <Link href="/" className="text-sm text-neutral-500 hover:underline">
            ← Deals
          </Link>
        </div>
        {errorKind && <ErrorBanner kind={errorKind} />}
        <div className="rounded border bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm text-neutral-600">
            Uses this week&apos;s deals to suggest 21 meals — takes about 10 seconds.
          </p>
          <GenerateForm label="Generate this week's plan" />
        </div>
      </main>
    );
  }

  const today = todayName();
  return (
    <main>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Week of {plan.week_of}</h2>
        <div className="flex items-center gap-3">
          <RegenerateButton />
          <Link href="/" className="text-sm text-neutral-500 hover:underline">
            ← Deals
          </Link>
        </div>
      </div>
      {errorKind && <ErrorBanner kind={errorKind} />}
      <ol className="space-y-2">
        {plan.days.map((d) => (
          <li key={d.day}>
            <DayAccordion
              day={d}
              initiallyOpen={d.day === today}
              isToday={d.day === today}
            />
          </li>
        ))}
      </ol>
      {plan.snacks.length > 0 && (
        <section className="mt-6 rounded border border-amber-200 bg-amber-50 p-3">
          <h3 className="mb-2 text-sm font-semibold text-amber-900">
            This week&apos;s snacks
          </h3>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {plan.snacks.map((s) => (
              <li key={s.id} className="text-sm text-amber-900">
                • {s.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

import Link from 'next/link';
import { getCurrentWeekPlan } from '@/lib/meal-planner/read';

export const dynamic = 'force-dynamic';

const ERROR_COPY: Record<string, string> = {
  anthropic: 'Planner service unavailable. Please try again.',
  json: 'Planner returned an unreadable response. Please try again.',
  schema: 'Planner returned a badly-shaped plan. Please try again.',
  sanity: 'Planner returned an invalid plan (missing ingredients or bad cook time). Please try again.',
  variety: 'Planner could not vary cuisines enough. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

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

  // Populated view — full render lands in Task 12.
  return (
    <main>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Week of {plan.week_of}</h2>
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← Deals
        </Link>
      </div>
      {errorKind && <ErrorBanner kind={errorKind} />}
      <p className="text-sm text-neutral-500">
        Plan loaded ({plan.days.length} days, {plan.snacks.length} snacks). Full
        rendering added in Task 12.
      </p>
    </main>
  );
}

import { NextResponse } from 'next/server';
import { getPlannerInput } from '@/lib/meal-planner/inputs';
import { generatePlan } from '@/lib/meal-planner/generate';
import { savePlan } from '@/lib/meal-planner/persist';
import { getCurrentWeekOfISO } from '@/lib/dates';
import { getServerClient } from '@/lib/db/client';
import {
  AnthropicError,
  JsonParseError,
  ValidationError,
  VarietyError,
} from '@/lib/meal-planner/types';

function errorKind(err: unknown): string {
  if (err instanceof AnthropicError) return 'anthropic';
  if (err instanceof JsonParseError) return 'json';
  if (err instanceof VarietyError) return 'variety';
  if (err instanceof ValidationError) return err.kind; // 'schema' | 'sanity'
  return 'unknown';
}

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const redirect = (target: string) =>
    NextResponse.redirect(new URL(target, origin), 303);

  try {
    const supabase = getServerClient();
    const { data: canonicals, error: cErr } = await supabase
      .from('canonical_ingredients')
      .select('id');
    if (cErr) throw cErr;
    const canonicalIds = new Set(
      (canonicals ?? []).map((r) => r.id as string)
    );

    const input = await getPlannerInput();
    const plan = await generatePlan(input, canonicalIds);
    await savePlan(plan, getCurrentWeekOfISO());
    return redirect('/plan');
  } catch (err) {
    console.error('POST /api/plan/generate failed:', err);
    return redirect(`/plan?error=${encodeURIComponent(errorKind(err))}`);
  }
}

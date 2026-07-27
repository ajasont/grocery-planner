import { NextResponse } from 'next/server';
import { runMappingForUnmappedSkus } from '@/lib/normalization/runner';

export async function POST() {
  try {
    const result = await runMappingForUnmappedSkus();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

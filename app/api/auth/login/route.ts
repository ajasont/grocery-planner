import { NextResponse } from 'next/server';
import { constantTimeEqual } from '@/lib/auth/password';
import { signSession } from '@/lib/auth/session';

const COOKIE_NAME = 'gp_session';

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({}));
  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (typeof password !== 'string' || !constantTimeEqual(password, expected)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const token = await signSession({ userId: 'household' });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  return res;
}

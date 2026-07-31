import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';

const COOKIE_NAME = 'gp_session';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/jobs/weekly-refresh',
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
  try {
    await verifySession(token);
    return NextResponse.next();
  } catch {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

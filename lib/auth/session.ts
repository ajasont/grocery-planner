import { SignJWT, jwtVerify } from 'jose';

const DEFAULT_EXPIRES_SECONDS = 60 * 60 * 24 * 30; // 30 days

type SessionPayload = { userId: string };

function secret() {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 chars');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(
  payload: SessionPayload,
  opts: { expiresInSeconds?: number } = {}
): Promise<string> {
  const expires = opts.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  return await new SignJWT({ userId: payload.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expires}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret());
  if (typeof payload.userId !== 'string') {
    throw new Error('Invalid session payload');
  }
  return { userId: payload.userId };
}

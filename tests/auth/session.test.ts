import { describe, it, expect, beforeEach } from 'vitest';
import { signSession, verifySession } from '@/lib/auth/session';

describe('session', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'a'.repeat(64);
  });

  it('signs and verifies a session round-trip', async () => {
    const token = await signSession({ userId: 'household' });
    const payload = await verifySession(token);
    expect(payload.userId).toBe('household');
  });

  it('rejects tampered tokens', async () => {
    const token = await signSession({ userId: 'household' });
    const tampered = token.slice(0, -2) + 'xx';
    await expect(verifySession(tampered)).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const token = await signSession({ userId: 'household' }, { expiresInSeconds: -1 });
    await expect(verifySession(token)).rejects.toThrow();
  });
});

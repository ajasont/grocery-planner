import { describe, it, expect } from 'vitest';
import { isPublicPath } from '@/middleware';

describe('isPublicPath', () => {
  it('lets the Vercel Cron path through without auth', () => {
    expect(isPublicPath('/api/jobs/weekly-refresh')).toBe(true);
  });

  it('lets login and auth endpoints through', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
  });

  it('still requires auth for regular app paths', () => {
    expect(isPublicPath('/plan')).toBe(false);
    expect(isPublicPath('/pantry')).toBe(false);
    expect(isPublicPath('/api/plan/generate')).toBe(false);
    expect(isPublicPath('/api/admin/refresh-ht')).toBe(false);
  });
});

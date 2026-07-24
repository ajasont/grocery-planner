import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from '@/lib/auth/password';

describe('constantTimeEqual', () => {
  it('returns true for matching strings', () => {
    expect(constantTimeEqual('hunter2', 'hunter2')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(constantTimeEqual('hunter2', 'hunter3')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeEqual('short', 'much longer string')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

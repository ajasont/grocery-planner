import { describe, it, expect } from 'vitest';
import { getRetailerDisplayName } from '@/lib/retailers/display';

describe('getRetailerDisplayName', () => {
  it('maps harris-teeter to "Harris Teeter"', () => {
    expect(getRetailerDisplayName('harris-teeter')).toBe('Harris Teeter');
  });

  it('maps sprouts to "Sprouts"', () => {
    expect(getRetailerDisplayName('sprouts')).toBe('Sprouts');
  });

  it('maps target to "Target"', () => {
    expect(getRetailerDisplayName('target')).toBe('Target');
  });

  it('title-cases unknown hyphenated slugs as a fallback', () => {
    expect(getRetailerDisplayName('trader-joes')).toBe('Trader Joes');
  });

  it('title-cases unknown single-word slugs as a fallback', () => {
    expect(getRetailerDisplayName('aldi')).toBe('Aldi');
  });
});

import { describe, it, expect } from 'vitest';
import { STAPLE_CANONICAL_IDS } from '@/lib/pantry/staples';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

describe('STAPLE_CANONICAL_IDS', () => {
  it('has exactly 15 entries', () => {
    expect(STAPLE_CANONICAL_IDS).toHaveLength(15);
  });

  it('has no duplicates', () => {
    expect(new Set(STAPLE_CANONICAL_IDS).size).toBe(STAPLE_CANONICAL_IDS.length);
  });

  it('every entry exists in the canonical-ingredients seed', () => {
    const seedIds = new Set(CANONICAL_INGREDIENTS.map((c) => c.id));
    for (const id of STAPLE_CANONICAL_IDS) {
      expect(seedIds.has(id), `staple '${id}' missing from seed`).toBe(true);
    }
  });
});

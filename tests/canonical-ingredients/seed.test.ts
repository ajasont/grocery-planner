import { describe, it, expect } from 'vitest';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

const byId = new Map(CANONICAL_INGREDIENTS.map((c) => [c.id, c]));

const PASTA_SHAPES = [
  'pasta_spaghetti',
  'pasta_penne',
  'pasta_rigatoni',
  'pasta_farfalle',
  'pasta_orzo',
  'pasta_linguine',
] as const;

// Explicitly ungrouped — either not Italian pasta shapes (noodles, sauce) or
// not substitutable at the shopping-list level.
const EXPLICITLY_UNGROUPED = [
  'noodle_ramen',
  'noodle_udon',
  'noodle_rice',
  'lasagna_noodle',
  'pasta_sauce_jar',
] as const;

describe('canonical ingredients seed — shopping_group', () => {
  it('assigns shopping_group="pasta" to every Italian pasta shape', () => {
    for (const id of PASTA_SHAPES) {
      const row = byId.get(id);
      expect(row, `${id} missing from seed data`).toBeDefined();
      expect(row?.shopping_group, `${id} should be in pasta group`).toBe('pasta');
    }
  });

  it('keeps noodles, lasagna noodles, and pasta sauce ungrouped', () => {
    for (const id of EXPLICITLY_UNGROUPED) {
      const row = byId.get(id);
      expect(row, `${id} missing from seed data`).toBeDefined();
      expect(row?.shopping_group, `${id} must not be grouped`).toBeNull();
    }
  });

  it('does not set shopping_group on any non-listed row (guard against typos)', () => {
    const allowed = new Set<string>(['pasta']);
    const offenders = CANONICAL_INGREDIENTS.filter(
      (c) => c.shopping_group !== null && !allowed.has(c.shopping_group)
    );
    expect(offenders, 'unexpected shopping_group values found').toEqual([]);
  });
});

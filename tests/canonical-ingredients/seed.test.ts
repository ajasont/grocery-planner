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

describe('canonical ingredients seed — mapper fix additions', () => {
  it('includes mahi_mahi as a seafood canonical', () => {
    const row = byId.get('mahi_mahi');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Mahi Mahi');
    expect(row?.category).toBe('seafood');
    expect(row?.aisle_group).toBe('seafood');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });

  it('includes turkey_sausage as a poultry canonical', () => {
    const row = byId.get('turkey_sausage');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Turkey Sausage');
    expect(row?.category).toBe('poultry');
    expect(row?.aisle_group).toBe('meat');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });

  it('includes margarine as a dairy-aisle canonical', () => {
    const row = byId.get('margarine');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Margarine');
    expect(row?.category).toBe('dairy');
    expect(row?.aisle_group).toBe('dairy');
    expect(row?.default_unit).toBe('lb');
    expect(row?.shopping_group).toBeNull();
  });
});

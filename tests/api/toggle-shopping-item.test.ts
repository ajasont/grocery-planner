import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spies for shopping_list_checks (upsert / delete) and pantry (upsert).
const checksUpsertSpy = vi.fn(async () => ({ error: null }));
const checksDeleteCall = vi.fn(async () => ({ error: null }));
const pantryUpsertSpy = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table === 'shopping_list_checks') {
        return {
          upsert: (rows: unknown) => checksUpsertSpy(rows as unknown),
          delete: () => ({
            eq: (_col: string, _v: unknown) => ({
              in: (_col2: string, ids: string[]) => checksDeleteCall(ids),
            }),
          }),
        };
      }
      if (table === 'pantry') {
        return {
          upsert: (row: unknown) => pantryUpsertSpy(row as unknown),
        };
      }
      throw new Error('unexpected table ' + table);
    },
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { toggleShoppingItem } from '@/app/plan/shopping-list/actions';

beforeEach(() => {
  checksUpsertSpy.mockClear();
  checksDeleteCall.mockClear();
  pantryUpsertSpy.mockClear();
});

describe('toggleShoppingItem — group semantics', () => {
  it('check-on with two member ids inserts two check rows and two pantry rows', async () => {
    await toggleShoppingItem(1, ['pasta_penne', 'pasta_rigatoni'], true);
    expect(checksUpsertSpy).toHaveBeenCalledTimes(1);
    const rows = checksUpsertSpy.mock.calls[0][0] as Array<{
      meal_plan_id: number;
      canonical_ingredient_id: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.canonical_ingredient_id).sort()).toEqual(['pasta_penne', 'pasta_rigatoni']);

    expect(pantryUpsertSpy).toHaveBeenCalledTimes(2);
  });

  it('check-off deletes exactly the given member ids from checks, leaves pantry alone', async () => {
    await toggleShoppingItem(1, ['pasta_penne', 'pasta_rigatoni'], false);
    expect(checksDeleteCall).toHaveBeenCalledWith(['pasta_penne', 'pasta_rigatoni']);
    expect(pantryUpsertSpy).not.toHaveBeenCalled();
    expect(checksUpsertSpy).not.toHaveBeenCalled();
  });

  it('ungrouped canonical (single-member array) behaves identically to prior single-id behavior', async () => {
    await toggleShoppingItem(1, ['chicken_breast'], true);
    const rows = checksUpsertSpy.mock.calls[0][0] as unknown[];
    expect(rows).toHaveLength(1);
    expect(pantryUpsertSpy).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const notCalls: Array<{ column: string; op: string; value: unknown }> = [];
const eqCalls: Array<{ column: string; value: unknown }> = [];
const orderCalls: Array<{ column: string }> = [];

const mockAwait = vi.fn(async () => ({ data: [], error: null }));

vi.mock('@/lib/db/client', () => ({
  getServerClient: () => ({
    from: (table: string) => {
      if (table !== 'deals') throw new Error('unexpected table ' + table);
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          eqCalls.push({ column, value });
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          notCalls.push({ column, op, value });
          return builder;
        },
        order(column: string) {
          orderCalls.push({ column });
          return mockAwait();
        },
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/dates', () => ({
  getCurrentWeekOfISO: () => '2026-08-10',
}));

import { getCurrentWeekOnSaleDeals } from '@/lib/deals/read';

beforeEach(() => {
  notCalls.length = 0;
  eqCalls.length = 0;
  orderCalls.length = 0;
  mockAwait.mockClear().mockResolvedValue({ data: [], error: null });
});

describe('getCurrentWeekOnSaleDeals', () => {
  it('filters by current week_of and sale_price not null', async () => {
    await getCurrentWeekOnSaleDeals();
    expect(eqCalls).toContainEqual({ column: 'week_of', value: '2026-08-10' });
    expect(notCalls).toContainEqual({
      column: 'sale_price',
      op: 'is',
      value: null,
    });
  });

  it('excludes SKUs explicitly flagged is_ingredient=false', async () => {
    await getCurrentWeekOnSaleDeals();
    expect(notCalls).toContainEqual({
      column: 'retailer_skus.is_ingredient',
      op: 'is',
      value: false,
    });
  });
});

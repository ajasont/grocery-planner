import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

import { classifyProductNames } from '@/lib/normalization/classifier';

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('classifyProductNames', () => {
  it('returns one result per input in order', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: true, confidence: 0.95, reason: 'meat' },
              { index: 1, is_ingredient: false, confidence: 0.9, reason: 'floral' },
            ],
          },
        },
      ],
    });

    const result = await classifyProductNames([
      'Boneless Chicken Breast',
      'Large Rose Bunches',
    ]);

    expect(result).toEqual([
      { is_ingredient: true, confidence: 0.95, reason: 'meat' },
      { is_ingredient: false, confidence: 0.9, reason: 'floral' },
    ]);
  });

  it('returns [] for empty input without calling Haiku', async () => {
    const result = await classifyProductNames([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defaults to is_ingredient=true when Haiku omits an index (safety)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: false, confidence: 0.9, reason: 'candy' },
            ],
          },
        },
      ],
    });

    const result = await classifyProductNames(['Bulk Candy', 'Missing Item']);
    expect(result[0]).toEqual({ is_ingredient: false, confidence: 0.9, reason: 'candy' });
    // Missing index: default to true / confidence 0 / empty reason so nothing gets hidden by omission.
    expect(result[1]).toEqual({ is_ingredient: true, confidence: 0, reason: '' });
  });

  it('sends a system prompt with the named-example guardrails on every batch', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: [
              { index: 0, is_ingredient: true, confidence: 0.9, reason: 'meat' },
            ],
          },
        },
      ],
    });

    await classifyProductNames(['Boneless Chicken Breast']);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0] as { system?: string };
    expect(typeof args.system).toBe('string');
    // Guardrails: the prompt must reference the known noise categories so a
    // future edit that drops them fails this test.
    expect(args.system).toMatch(/Rose/i);
    expect(args.system).toMatch(/MADE-TO-ORDER/i);
    expect(args.system).toMatch(/Water/i);
    expect(args.system).toMatch(/Candy/i);
    // "When in doubt, return true" safety net.
    expect(args.system).toMatch(/doubt/i);
  });

  it('batches large inputs into multiple Haiku calls (BATCH_SIZE=20)', async () => {
    // 25 items → 2 batches (20 + 5). Each batch's Haiku response uses local indices.
    const names = Array.from({ length: 25 }, (_, i) => `Item ${i}`);

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: Array.from({ length: 20 }, (_, i) => ({
              index: i,
              is_ingredient: true,
              confidence: 0.9,
              reason: 'batch1',
            })),
          },
        },
      ],
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_ingredients',
          input: {
            classifications: Array.from({ length: 5 }, (_, i) => ({
              index: i,
              is_ingredient: false,
              confidence: 0.8,
              reason: 'batch2',
            })),
          },
        },
      ],
    });

    const result = await classifyProductNames(names);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(25);
    // First batch: indices 0-19, is_ingredient=true
    expect(result[0].reason).toBe('batch1');
    expect(result[19].reason).toBe('batch1');
    expect(result[19].is_ingredient).toBe(true);
    // Second batch: indices 20-24, is_ingredient=false (proves global-index translation)
    expect(result[20].reason).toBe('batch2');
    expect(result[24].reason).toBe('batch2');
    expect(result[24].is_ingredient).toBe(false);
  });
});

'use client';

import type { PantryItem } from '@/lib/pantry/queries';

export function PantryList({
  items,
  pending,
  onRemove,
}: {
  items: PantryItem[];
  pending: Set<string>;
  onRemove: (canonicalId: string) => Promise<void>;
}) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        In your pantry
      </h2>
      <ul className="divide-y divide-gray-200">
        {sorted.map((item) => {
          const isPending = pending.has(item.canonicalId);
          return (
            <li
              key={item.canonicalId}
              className="flex items-center justify-between py-2"
            >
              <span>{item.name}</span>
              <button
                type="button"
                disabled={isPending}
                onClick={() => onRemove(item.canonicalId)}
                className={
                  'text-gray-400 hover:text-red-600 text-lg leading-none w-8 h-8 flex items-center justify-center rounded ' +
                  (isPending ? 'opacity-60 cursor-wait' : '')
                }
                aria-label={`Remove ${item.name} from pantry`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

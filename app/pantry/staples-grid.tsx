'use client';

import { STAPLE_CANONICAL_IDS } from '@/lib/pantry/staples';

export function StaplesGrid({
  idSet,
  nameById,
  pending,
  onAdd,
  onRemove,
}: {
  idSet: Set<string>;
  nameById: Map<string, string>;
  pending: Set<string>;
  onAdd: (canonicalId: string) => Promise<void>;
  onRemove: (canonicalId: string) => Promise<void>;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Staples
      </h2>
      <div className="flex flex-wrap gap-2">
        {STAPLE_CANONICAL_IDS.map((id) => {
          const active = idSet.has(id);
          const isPending = pending.has(id);
          const label = nameById.get(id) ?? id;
          return (
            <button
              key={id}
              type="button"
              disabled={isPending}
              onClick={() => (active ? onRemove(id) : onAdd(id))}
              className={
                'px-3 py-1.5 rounded-full text-sm border transition-colors ' +
                (active
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50') +
                (isPending ? ' opacity-60 cursor-wait' : '')
              }
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

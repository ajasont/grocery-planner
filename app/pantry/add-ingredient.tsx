'use client';

import { useMemo, useState } from 'react';
import type { Canonical } from './pantry-page';

export function AddIngredient({
  allCanonicals,
  idSet,
  onAdd,
}: {
  allCanonicals: Canonical[];
  idSet: Set<string>;
  onAdd: (canonicalId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allCanonicals
      .filter((c) => !idSet.has(c.id) && c.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, allCanonicals, idSet]);

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Add ingredient
      </h2>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to search (e.g. cinnamon)"
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {matches.length > 0 && (
        <ul className="mt-2 border border-gray-200 rounded divide-y divide-gray-200">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={async () => {
                  await onAdd(c.id);
                  setQuery('');
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

'use client';

import { useCallback, useMemo, useState } from 'react';
import type { PantryItem } from '@/lib/pantry/queries';
import { addToPantry, removeFromPantry } from '@/lib/pantry/actions';
import { StaplesGrid } from './staples-grid';
import { PantryList } from './pantry-list';
import { AddIngredient } from './add-ingredient';

export type Canonical = { id: string; name: string };

export function PantryPage({
  initialPantry,
  allCanonicals,
}: {
  initialPantry: PantryItem[];
  allCanonicals: Canonical[];
}) {
  // Single source of truth for what's currently in the pantry.
  const [items, setItems] = useState<PantryItem[]>(initialPantry);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const idSet = useMemo(() => new Set(items.map((i) => i.canonicalId)), [items]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCanonicals) m.set(c.id, c.name);
    return m;
  }, [allCanonicals]);

  const add = useCallback(
    async (canonicalId: string) => {
      if (pending.has(canonicalId)) return;
      if (idSet.has(canonicalId)) return; // already in pantry — no-op
      const name = nameById.get(canonicalId);
      if (!name) return; // unknown canonical — bail
      const optimistic = { canonicalId, name };
      setItems((prev) => [...prev, optimistic]);
      setPending((prev) => new Set(prev).add(canonicalId));
      setError(null);
      try {
        await addToPantry(canonicalId);
      } catch {
        setItems((prev) => prev.filter((i) => i.canonicalId !== canonicalId));
        setError('Could not update pantry — try again');
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(canonicalId);
          return next;
        });
      }
    },
    [idSet, nameById, pending]
  );

  const remove = useCallback(
    async (canonicalId: string) => {
      if (pending.has(canonicalId)) return;
      if (!idSet.has(canonicalId)) return; // not present — no-op
      const removed = items.find((i) => i.canonicalId === canonicalId);
      setItems((prev) => prev.filter((i) => i.canonicalId !== canonicalId));
      setPending((prev) => new Set(prev).add(canonicalId));
      setError(null);
      try {
        await removeFromPantry(canonicalId);
      } catch {
        if (removed) setItems((prev) => [...prev, removed]);
        setError('Could not update pantry — try again');
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(canonicalId);
          return next;
        });
      }
    },
    [idSet, items, pending]
  );

  return (
    <div className="space-y-8">
      <StaplesGrid idSet={idSet} nameById={nameById} pending={pending} onAdd={add} onRemove={remove} />
      <PantryList items={items} pending={pending} onRemove={remove} />
      <AddIngredient allCanonicals={allCanonicals} idSet={idSet} onAdd={add} />
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

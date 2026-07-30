'use client';

import { useState, useTransition } from 'react';
import { toggleShoppingItem } from './actions';

export function ShoppingItemCheckbox({
  planId,
  canonicalId,
  initialChecked,
  children,
}: {
  planId: number;
  canonicalId: string;
  initialChecked: boolean;
  children: React.ReactNode;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [pending, startTransition] = useTransition();

  return (
    <label
      className={`flex items-center gap-3 py-1 cursor-pointer ${
        checked ? 'line-through opacity-60' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          if (pending) return;
          const next = e.target.checked;
          setChecked(next);
          startTransition(async () => {
            try {
              await toggleShoppingItem(planId, canonicalId, next);
            } catch {
              setChecked(!next);
            }
          });
        }}
      />
      <span className="flex-1">{children}</span>
    </label>
  );
}

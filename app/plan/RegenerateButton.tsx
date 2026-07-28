'use client';

import { useRef } from 'react';

export function RegenerateButton() {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action="/api/plan/generate" method="POST">
      <button
        type="button"
        onClick={() => {
          if (
            confirm(
              'This will replace your current plan with a freshly-generated one. Continue?'
            )
          ) {
            formRef.current?.submit();
          }
        }}
        className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
      >
        Regenerate
      </button>
    </form>
  );
}

'use client';

import { useState } from 'react';
import type { RenderableDay, RenderableMeal } from '@/lib/meal-planner/types';

const DAY_LABEL: Record<RenderableDay['day'], string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

function MealRow({
  label,
  meal,
}: {
  label: string;
  meal: RenderableMeal | null;
}) {
  if (!meal) return null;
  return (
    <div className="flex items-start gap-3 py-1.5 text-sm">
      <span className="w-16 shrink-0 text-xs uppercase text-neutral-400">{label}</span>
      <div className="flex-1">
        <p className="text-neutral-900">{meal.name}</p>
        {meal.cook_time_minutes !== null && (
          <p className="text-xs text-neutral-500">{meal.cook_time_minutes}m</p>
        )}
      </div>
    </div>
  );
}

export function DayAccordion({
  day,
  initiallyOpen,
  isToday,
}: {
  day: RenderableDay;
  initiallyOpen: boolean;
  isToday: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const label = DAY_LABEL[day.day];

  return (
    <div
      className={`rounded border bg-white shadow-sm ${
        isToday ? 'border-blue-300 ring-1 ring-blue-100' : 'border-neutral-200'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          {isToday && (
            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
              Today
            </span>
          )}
          <span className="text-sm font-semibold">{label}</span>
          {!open && day.dinner && (
            <span className="truncate text-xs text-neutral-500">
              · {day.dinner.name}
            </span>
          )}
        </div>
        <span className="text-neutral-400" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="border-t border-neutral-100 px-3 py-2">
          <MealRow label="Breakfast" meal={day.breakfast} />
          <MealRow label="Lunch" meal={day.lunch} />
          <MealRow label="Dinner" meal={day.dinner} />
        </div>
      )}
    </div>
  );
}

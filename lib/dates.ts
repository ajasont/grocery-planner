// Returns the Sunday ISO date (YYYY-MM-DD) of the current week in UTC.
// Used as the `week_of` key across deals, meal plans, and shopping lists.
export function getCurrentWeekOfISO(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

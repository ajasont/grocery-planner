// Fixed order — matches the display grid on /pantry.
// Every ID must exist in lib/canonical-ingredients/seed-data.ts
// (guarded by tests/pantry/staples.test.ts).
export const STAPLE_CANONICAL_IDS: readonly string[] = [
  'olive_oil',
  'salt_kosher',
  'pepper_black',
  'yellow_onion',
  'garlic',
  'flour_ap',
  'sugar_white',
  'rice_white_long',
  'pasta_spaghetti',
  'tomato_crushed_canned',
  'soy_sauce',
  'egg_large',
  'milk_whole',
  'butter_unsalted',
  'coffee_ground',
] as const;

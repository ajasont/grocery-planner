const DISPLAY_NAMES: Record<string, string> = {
  'harris-teeter': 'Harris Teeter',
  sprouts: 'Sprouts',
  target: 'Target',
  safeway: 'Safeway',
  giant: 'Giant',
};

export function getRetailerDisplayName(slug: string): string {
  const known = DISPLAY_NAMES[slug];
  if (known) return known;
  return slug
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

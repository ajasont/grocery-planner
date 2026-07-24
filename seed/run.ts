import { config } from 'dotenv';
config({ path: '.env.local' });
import { getServerClient } from '@/lib/db/client';
import { CANONICAL_INGREDIENTS } from '@/lib/canonical-ingredients/seed-data';

async function main() {
  const supabase = getServerClient();

  console.log(`Seeding ${CANONICAL_INGREDIENTS.length} canonical ingredients…`);
  const { error } = await supabase
    .from('canonical_ingredients')
    .upsert(CANONICAL_INGREDIENTS, { onConflict: 'id' });

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
  console.log('Seed complete.');
}

main();

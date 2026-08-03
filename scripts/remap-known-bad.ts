import { config } from 'dotenv';
config({ path: '.env.local' });
import { getServerClient } from '../lib/db/client';
import { runMappingForUnmappedSkus } from '../lib/normalization/runner';

// Retailer product name patterns → the canonical they are currently mis-mapped to.
// We unset the mapping on any SKU where BOTH the name matches AND the current
// canonical matches, so the next mapper pass re-maps them against the corrected
// canonical list. Rows correctly mapped are untouched.
const BAD_MAPPINGS: Array<{ namePattern: string; wrongCanonical: string }> = [
  { namePattern: '%mahi%',           wrongCanonical: 'cod_fillet' },
  { namePattern: '%turkey%sausage%', wrongCanonical: 'turkey_breast' },
  { namePattern: '%turkey%link%',    wrongCanonical: 'turkey_breast' },
  { namePattern: '%margarine%',      wrongCanonical: 'butter_salted' },
];

async function main() {
  const supabase = getServerClient();
  let totalCleared = 0;

  for (const { namePattern, wrongCanonical } of BAD_MAPPINGS) {
    const { data, error } = await supabase
      .from('retailer_skus')
      .update({ canonical_ingredient_id: null, mapping_verified: false })
      .ilike('product_name', namePattern)
      .eq('canonical_ingredient_id', wrongCanonical)
      .select('id');
    if (error) throw error;
    console.log(`  cleared ${data?.length ?? 0} rows: product_name ilike "${namePattern}" mapped to ${wrongCanonical}`);
    totalCleared += data?.length ?? 0;
  }

  console.log(`\nCleared ${totalCleared} bad mappings. Re-running mapper...\n`);

  const result = await runMappingForUnmappedSkus();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { config } from 'dotenv';
config({ path: '.env.local' });
import { runMappingForUnmappedSkus } from '../lib/normalization/runner';

async function main() {
  const result = await runMappingForUnmappedSkus();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

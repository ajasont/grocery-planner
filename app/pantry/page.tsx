import Link from 'next/link';
import { getServerClient } from '@/lib/db/client';
import { listPantry } from '@/lib/pantry/queries';
import { PantryPage } from './pantry-page';

export const dynamic = 'force-dynamic';

type CanonicalRow = { id: string; name: string };

export default async function PantryRoute() {
  const supabase = getServerClient();

  const [pantry, canonicalsResult] = await Promise.all([
    listPantry(),
    supabase
      .from('canonical_ingredients')
      .select('id, name')
      .order('name'),
  ]);
  if (canonicalsResult.error) throw canonicalsResult.error;
  const canonicals = (canonicalsResult.data ?? []) as CanonicalRow[];

  return (
    <main className="max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <Link href="/plan" className="text-sm text-blue-600 hover:underline">
          ← Back to plan
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Pantry</h1>
        <p className="text-sm text-gray-500">
          Anything here gets skipped in your shopping list.
        </p>
      </header>

      <PantryPage initialPantry={pantry} allCanonicals={canonicals} />
    </main>
  );
}

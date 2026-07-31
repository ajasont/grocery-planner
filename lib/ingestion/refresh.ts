import { fetchHarrisTeeterDeals } from '@/lib/ingestion/harris-teeter';
import { fetchSproutsDeals } from '@/lib/ingestion/sprouts';
import { persistDeals } from '@/lib/ingestion/persist';
import { getServerClient } from '@/lib/db/client';

const ZIP = '21224';

export type RefreshRetailerName = 'harris-teeter' | 'sprouts';

export type RefreshResult = {
  retailer: RefreshRetailerName;
  status: 'OK' | 'FAILED';
  dealsFetched: number;
  dealsUpserted: number;
  error: string | null;
};

async function fetchFor(name: RefreshRetailerName) {
  if (name === 'harris-teeter') return fetchHarrisTeeterDeals(ZIP);
  return fetchSproutsDeals(ZIP);
}

async function touchHealthFailed(
  name: RefreshRetailerName,
  message: string
): Promise<void> {
  const supabase = getServerClient();
  const { data: retailerRow, error: rErr } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', name)
    .single();
  if (rErr || !retailerRow) return;
  const retailerId = retailerRow.id;

  // Preserve last_success_at so the dashboard can still show "last good sync".
  const { data: existing } = await supabase
    .from('retailer_health')
    .select('last_success_at')
    .eq('retailer_id', retailerId)
    .maybeSingle();

  await supabase.from('retailer_health').upsert(
    {
      retailer_id: retailerId,
      last_success_at: existing?.last_success_at ?? null,
      last_status: 'FAILED',
      last_error: message,
    },
    { onConflict: 'retailer_id' }
  );
}

export async function refreshRetailer(
  name: RefreshRetailerName
): Promise<RefreshResult> {
  try {
    const fetched = await fetchFor(name);
    const persisted = await persistDeals({
      retailer: name,
      stores: fetched.stores,
      deals: fetched.deals,
    });
    return {
      retailer: name,
      status: 'OK',
      dealsFetched: fetched.deals.length,
      dealsUpserted: persisted.dealsUpserted,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await touchHealthFailed(name, message);
    } catch {
      // Swallow — the caller always gets a RefreshResult.
    }
    return {
      retailer: name,
      status: 'FAILED',
      dealsFetched: 0,
      dealsUpserted: 0,
      error: message,
    };
  }
}

const LOCATIONS_URL = 'https://api.kroger.com/v1/locations';

export type HTStore = {
  store_number: string;
  name: string;
  address: string;
  zip: string;
};

type KrogerLocation = {
  locationId: string;
  name: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
};

export async function findHarrisTeeterStores(
  zip: string,
  accessToken: string,
  radiusMiles = 15
): Promise<HTStore[]> {
  const url = new URL(LOCATIONS_URL);
  url.searchParams.set('filter.zipCode.near', zip);
  url.searchParams.set('filter.chain', 'HARRISTEETER');
  url.searchParams.set('filter.radiusInMiles', String(radiusMiles));

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kroger locations failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: KrogerLocation[] };
  return data.data.map((loc) => ({
    store_number: loc.locationId,
    name: loc.name,
    address: `${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.state} ${loc.address.zipCode}`,
    zip: loc.address.zipCode,
  }));
}

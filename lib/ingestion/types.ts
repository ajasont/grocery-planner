export type NormalizedDeal = {
  retailer: 'harris-teeter' | 'target' | 'safeway' | 'giant' | 'sprouts';
  store_number: string;
  sku: string;
  product_name: string;
  package_size: number | null;
  package_unit: string | null;
  image_url: string | null;
  regular_price: number | null;
  sale_price: number | null;
  on_sale: boolean;
  source: 'api' | 'flipp';
};

export type IngestionStore = {
  store_number: string;
  address: string | null;
  zip: string | null;
};

export type RetailerName = NormalizedDeal['retailer'];

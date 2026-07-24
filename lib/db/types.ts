export type Retailer = {
  id: number;
  name: 'harris-teeter' | 'target' | 'safeway' | 'giant' | 'sprouts';
  deep_link_pattern: string | null;
};

export type Store = {
  id: number;
  retailer_id: number;
  store_number: string;
  address: string | null;
  zip: string | null;
  is_active: boolean;
};

export type CanonicalIngredient = {
  id: string;
  name: string;
  category: string | null;
  default_unit: string | null;
  aisle_group: string | null;
};

export type RetailerSku = {
  id: number;
  retailer_id: number;
  sku: string;
  product_name: string;
  package_size: number | null;
  package_unit: string | null;
  image_url: string | null;
  canonical_ingredient_id: string | null;
  mapping_confidence: number | null;
  mapping_verified: boolean;
};

export type Deal = {
  id: number;
  retailer_sku_id: number;
  store_id: number;
  week_of: string;            // ISO date
  regular_price: number | null;
  sale_price: number | null;
  unit_price: number | null;
  valid_from: string | null;
  valid_until: string | null;
  source: 'api' | 'flipp';
};

export type RetailerHealth = {
  id: number;
  retailer_id: number;
  last_success_at: string | null;
  last_status: 'OK' | 'DEGRADED' | 'FAILED' | null;
  last_error: string | null;
};

export type Tables = {
  retailers: Retailer;
  stores: Store;
  canonical_ingredients: CanonicalIngredient;
  retailer_skus: RetailerSku;
  deals: Deal;
  retailer_health: RetailerHealth;
};

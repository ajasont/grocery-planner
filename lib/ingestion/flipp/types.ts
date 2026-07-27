export type FlippMerchant = {
  id: number;
  name: string;
};

export type FlippItem = {
  id: number;
  flyer_item_id: number;
  flyer_id: number;
  merchant_id: number;
  merchant_name: string;
  name: string;
  item_type: string;
  current_price: number | null;
  original_price: number | null;
  pre_price_text: string | null;
  post_price_text: string | null;
  sale_story: string | null;
  valid_from: string | null;
  valid_to: string | null;
  clean_image_url: string | null;
  clipping_image_url: string | null;
};

export type FlippSearchResponse = {
  merchants: FlippMerchant[];
  items: FlippItem[];
};

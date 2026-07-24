-- Retailers and their stores
create table retailers (
  id serial primary key,
  name text not null unique,
  deep_link_pattern text
);

create table stores (
  id serial primary key,
  retailer_id int not null references retailers(id),
  store_number text not null,
  address text,
  zip text,
  is_active boolean not null default true,
  unique (retailer_id, store_number)
);

-- Canonical ingredient vocabulary
create table canonical_ingredients (
  id text primary key,           -- e.g. 'chicken_breast'
  name text not null,
  category text,
  default_unit text,
  aisle_group text
);

create table retailer_skus (
  id serial primary key,
  retailer_id int not null references retailers(id),
  sku text not null,
  product_name text not null,
  package_size numeric,
  package_unit text,
  image_url text,
  canonical_ingredient_id text references canonical_ingredients(id),
  mapping_confidence numeric,
  mapping_verified boolean not null default false,
  unique (retailer_id, sku)
);

create table deals (
  id serial primary key,
  retailer_sku_id int not null references retailer_skus(id),
  store_id int not null references stores(id),
  week_of date not null,
  regular_price numeric,
  sale_price numeric,
  unit_price numeric,
  valid_from date,
  valid_until date,
  source text not null,          -- 'api' | 'flipp'
  unique (retailer_sku_id, store_id, week_of)
);

-- Pantry, plans, shopping lists
create table pantry (
  id serial primary key,
  canonical_ingredient_id text not null references canonical_ingredients(id) unique,
  quantity numeric,
  unit text,
  updated_at timestamptz not null default now()
);

create table meal_plans (
  id serial primary key,
  week_of date not null,
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

create table meals (
  id serial primary key,
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  day text not null,
  meal_type text not null,
  name text not null,
  cuisine text,
  cook_time_minutes int,
  servings int,
  notes text
);

create table meal_ingredients (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  quantity numeric,
  unit text
);

create table recipe_steps (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade unique,
  steps_json jsonb not null,
  generated_at timestamptz not null default now()
);

create table meal_ratings (
  id serial primary key,
  meal_id int not null references meals(id) on delete cascade,
  rating text not null,          -- 'up' | 'down'
  note text,
  created_at timestamptz not null default now()
);

create table shopping_lists (
  id serial primary key,
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  max_stores int not null default 3,
  created_at timestamptz not null default now()
);

create table shopping_list_items (
  id serial primary key,
  shopping_list_id int not null references shopping_lists(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  quantity numeric,
  unit text,
  assigned_store_id int references stores(id),
  retailer_sku_id int references retailer_skus(id),
  price numeric,
  deep_link_url text,
  purchased_at timestamptz
);

-- Health monitoring
create table retailer_health (
  id serial primary key,
  retailer_id int not null references retailers(id) unique,
  last_success_at timestamptz,
  last_status text,
  last_error text
);

-- Household preferences (see spec Section 12)
create table household_preferences (
  id int primary key default 1 check (id = 1),
  dietary_flags jsonb not null default '[]'::jsonb,
  disliked_ingredients jsonb not null default '[]'::jsonb,
  liked_ingredients jsonb not null default '[]'::jsonb,
  disliked_cuisines jsonb not null default '[]'::jsonb,
  liked_cuisines jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Seed the single household_preferences row
insert into household_preferences (id) values (1);

-- Seed retailers
insert into retailers (name, deep_link_pattern) values
  ('harris-teeter', 'https://www.harristeeter.com/product/{sku}'),
  ('target',        'https://www.target.com/p/-/A-{sku}'),
  ('safeway',       'https://www.safeway.com/shop/product-details.{sku}.html'),
  ('giant',         'https://giantfood.com/product/{sku}'),
  ('sprouts',       null);

-- Index for deal lookups
create index idx_deals_week on deals(week_of);
create index idx_deals_store on deals(store_id);

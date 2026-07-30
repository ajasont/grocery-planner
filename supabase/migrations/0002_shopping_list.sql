-- 0002_shopping_list.sql
-- Drop Week 1 placeholder tables that were never populated by any code.
-- They are superseded by shopping_list_checks (below).
drop table if exists shopping_list_items;
drop table if exists shopping_lists;

-- Persistent check-state for /plan/shopping-list.
-- A row exists iff the item is currently checked. Toggle-off deletes the row.
-- Cascade wipes prior checks when the plan is regenerated.
create table shopping_list_checks (
  meal_plan_id int not null references meal_plans(id) on delete cascade,
  canonical_ingredient_id text not null references canonical_ingredients(id),
  checked_at timestamptz not null default now(),
  primary key (meal_plan_id, canonical_ingredient_id)
);

-- Snapshot the pantry canonical_ingredient_ids at plan-generation time so the
-- shopping list can exclude items using the same pantry Haiku actually saw.
alter table meal_plans
  add column pantry_canonical_ingredient_ids text[] not null default '{}';

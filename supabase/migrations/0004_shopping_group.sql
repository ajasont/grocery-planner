-- 0004_shopping_group.sql
-- Optional grouping key for the shopping-list aggregator. When set, multiple
-- canonicals with the same shopping_group value roll up into one shopping-list
-- row (e.g., pasta_penne + pasta_rigatoni → "Pasta"). NULL means "aggregate as
-- itself" — the default and current behavior.
alter table canonical_ingredients
  add column shopping_group text null;

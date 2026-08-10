-- Flipp ingredient classifier (see docs/superpowers/plans/2026-08-10-flipp-ingredient-classifier.md).
-- Adds three nullable columns on retailer_skus + a partial index for the runner's select.
-- Also extends job_runs with classifier counters, mirroring the existing mapper_* columns.

alter table retailer_skus
  add column is_ingredient boolean,
  add column classification_confidence numeric,
  add column classification_reason text;

create index idx_retailer_skus_unclassified_flipp
  on retailer_skus (id)
  where is_ingredient is null and sku like 'flipp-%';

alter table job_runs
  add column classifier_status text check (classifier_status in ('OK', 'FAILED')),
  add column classifier_classified int not null default 0,
  add column classifier_flagged int not null default 0,
  add column classifier_failed int not null default 0,
  add column classifier_error text;

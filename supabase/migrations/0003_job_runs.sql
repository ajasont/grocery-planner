-- 0003_job_runs.sql
-- Per-run mapper stats from the weekly refresh cron.
-- One row per /api/jobs/weekly-refresh execution.
-- Retailer state stays in retailer_health (upsert-only) — this table is
-- append-only history for the mapper step, which was previously ephemeral.
create table job_runs (
  id serial primary key,
  run_at timestamptz not null default now(),
  mapper_status text not null check (mapper_status in ('OK', 'FAILED')),
  mapper_mapped int not null default 0,
  mapper_skipped int not null default 0,
  mapper_failed int not null default 0,
  mapper_error text
);

create index idx_job_runs_run_at on job_runs (run_at desc);

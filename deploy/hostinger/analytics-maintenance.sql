-- Daily replay retention for the merchant analytics console, which tells merchants that
-- replays are kept for 30 days. Apply to project mmyruzjemjecqyivhrgr after migration
-- 20261030100000_merchant_analytics. It holds no credential and is safe to re-run.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';
create extension if not exists pg_cron;

do $$
declare existing_job record;
begin
  perform pg_advisory_xact_lock(hashtextextended('kma-analytics-replay-retention-release', 0));
  select * into existing_job from cron.job where jobname = 'kma-analytics-replay-retention';
  if found then
    if existing_job.command <> 'select public.analytics_purge_replays();'
      or existing_job.schedule <> '17 3 * * *'
      or existing_job.database <> current_database()
      or existing_job.username <> current_user
      or not existing_job.active then
      raise exception 'Existing replay retention job differs; inspect before changing it';
    end if;
  else
    if exists (select 1 from cron.job where command ilike '%analytics_purge_replays%') then
      raise exception 'Another replay retention job exists; inspect before adding a duplicate';
    end if;
    perform cron.schedule('kma-analytics-replay-retention', '17 3 * * *',
      'select public.analytics_purge_replays();');
  end if;
end $$;
commit;

select jobid, jobname, schedule, command, database, username, active
from cron.job where jobname = 'kma-analytics-replay-retention';

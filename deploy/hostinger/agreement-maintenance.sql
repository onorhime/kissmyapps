-- Explicitly approved production operational setup, not a commercial worker.
-- Apply only to project mmyruzjemjecqyivhrgr after the audit migrations and
-- agreement-notify deployment. Never put the notification credential here.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';
create extension if not exists pg_cron;

do $$
declare existing_job record;
begin
  perform pg_advisory_xact_lock(hashtextextended('kma-agreement-maintenance-release', 0));
  select * into existing_job from cron.job where jobname = 'kma-agreement-maintenance';
  if found then
    if existing_job.command <> 'select kma_internal.dispatch_agreement_email_jobs();'
      or existing_job.schedule <> '* * * * *'
      or existing_job.database <> current_database()
      or existing_job.username <> current_user
      or not existing_job.active then
      raise exception 'Existing agreement maintenance job differs; inspect before changing it';
    end if;
  else
    if exists (select 1 from cron.job where command ilike '%dispatch_agreement_email_jobs%') then
      raise exception 'Another agreement dispatcher job exists; inspect before adding a duplicate';
    end if;
    perform cron.schedule('kma-agreement-maintenance', '* * * * *',
      'select kma_internal.dispatch_agreement_email_jobs();');
  end if;
end $$;
commit;

select jobid, jobname, schedule, command, database, username, active
from cron.job where jobname = 'kma-agreement-maintenance';

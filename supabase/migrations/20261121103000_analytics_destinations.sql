-- Affiliate self-serve, Phase 8: install sources sent to the merchant's own Amplitude.
--
-- A merchant pastes the API key of an Amplitude project on one KissMyApps analytics project.
-- From then on every matched app install of an identified person of that project (Phase 7,
-- attribution_installs) is sent to that Amplitude project once, as an Identify that sets the
-- user properties kma_source, kma_campaign, kma_method and kma_creator, and an event
-- "[KissMyApps] Install attributed" with the source, campaign, method, whether the match is
-- exact, the platform and the creator's public name when a creator's link brought it.
--
--   1. analytics_destinations holds the key (one per project and provider). Amplitude calls it
--      a client-side key, but it is still never handed back whole: the console reads its
--      last 4 characters, and only the worker's claim reads it.
--   2. analytics_destination_jobs is the queue. Triggers put an install on it when it is
--      written or its match changes, and when its person is identified (gets a user_id) later.
--      Only production installs that are matched (as attribution_answer says: not organic, not
--      rejected, with a source) of a person with a user_id, and only for a project that has a
--      destination. The triggers only add rows; they never fail the install or the event that
--      set them off.
--   3. The analytics-destinations-worker edge function claims jobs, sends them in batches and
--      finishes each one: sent; retried with backoff and failed after 10 attempts; or, when
--      Amplitude says the key is invalid, the destination is paused until the merchant saves
--      a key again, and the job waits.
--   4. A database schedule wakes the worker when a job is due (kma-analytics-destinations,
--      installed by hand: docs/affiliate-self-serve-phase8-deploy.md, "D. Amplitude").
--
-- Nothing is sent for installs made before the key was saved. No person data other than the
-- app's own user ID leaves for Amplitude, and nothing joins data across merchants: a job is
-- one install of the destination's own project, and a creator is named only for a click on a
-- product of a program of the same workspace.
begin;

create table public.analytics_destinations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  provider text not null check (provider in ('amplitude')),
  -- The Amplitude project API key: 32 lowercase hex characters.
  project_key text not null check (project_key ~ '^[0-9a-f]{32}$'),
  region text not null default 'us' check (region in ('us', 'eu')),
  -- active; failing (the last send failed, still trying); paused (the key was refused).
  status text not null default 'active' check (status in ('active', 'paused', 'failing')),
  -- When the key was last saved, so a refusal of an older key cannot pause a newer one.
  key_set_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text check (last_error ~ '^[a-z][a-z0-9_]{1,59}$'),
  last_error_at timestamptz,
  sent_total bigint not null default 0 check (sent_total >= 0),
  failed_total bigint not null default 0 check (failed_total >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint analytics_destination_once unique (project_id, provider)
);

-- One send of one install to one destination.
create table public.analytics_destination_jobs (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.analytics_destinations(id) on delete cascade,
  install_id uuid not null references public.attribution_installs(id) on delete cascade,
  -- pending (waiting or held by a worker); sent; failed (given up); skipped (by the time it
  -- was due the install was no longer one to send).
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  claimed_at timestamptz,
  last_error text check (last_error ~ '^[a-z][a-z0-9_]{1,59}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'pending') = (finished_at is null)),
  check (status = 'pending' or lease_token is null)
);
-- At most one waiting job per install and destination: it reads the install as it is when sent.
create unique index analytics_destination_jobs_pending
  on public.analytics_destination_jobs(destination_id, install_id) where status = 'pending';
create index analytics_destination_jobs_due
  on public.analytics_destination_jobs(next_attempt_at) where status = 'pending';
create index analytics_destination_jobs_install on public.analytics_destination_jobs(install_id, destination_id);
create index analytics_destination_jobs_finished
  on public.analytics_destination_jobs(destination_id, finished_at) where status in ('sent', 'failed');

alter table public.analytics_destinations enable row level security;
alter table public.analytics_destination_jobs enable row level security;
revoke all on public.analytics_destinations, public.analytics_destination_jobs
  from public, anon, authenticated, service_role;

-- Helpers ------------------------------------------------------------------------------------

-- An install that is sent: production, matched to a source and not rejected (the matched of
-- kma_internal.attribution_answer).
create function kma_internal.analytics_destination_sendable(i public.attribution_installs) returns boolean
language sql immutable set search_path = '' as $$
  select i.environment = 'production' and i.method <> 'organic' and i.verdict <> 'rejected' and i.source is not null
$$;

-- The public name of the creator whose link brought the install, or null. Only a click on a
-- live link to the product of a program of the install's own workspace names anybody.
create function kma_internal.analytics_destination_creator(i public.attribution_installs) returns text
language sql stable set search_path = '' as $$
  select f.public_name
  from public.clicks c
  join public.affiliate_links l on l.id = c.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
  join public.affiliate_programs g on g.product_id = c.product_id
  join public.analytics_projects pr on pr.id = i.project_id and pr.workspace_id = g.workspace_id
  join public.affiliates f on f.id = c.affiliate_id
  where i.creator_click is not null and i.verdict in ('counted', 'flagged')
    and c.public_click_id = i.creator_click and not c.is_bot
  limit 1
$$;

-- Puts the install on the queue of each destination of its project, when it is one to send
-- and its person has a user_id. p_again: also when it was sent before (its match changed);
-- otherwise only when it was never sent there.
create function kma_internal.analytics_destinations_enqueue(p_install public.attribution_installs, p_again boolean)
returns void language sql volatile set search_path = '' as $$
  insert into public.analytics_destination_jobs(destination_id, install_id)
  select d.id, p_install.id from public.analytics_destinations d
  where d.project_id = p_install.project_id
    and kma_internal.analytics_destination_sendable(p_install)
    and exists (select 1 from public.analytics_people pe where pe.id = p_install.person_id and pe.user_id is not null)
    and (p_again or not exists (select 1 from public.analytics_destination_jobs j
      where j.install_id = p_install.id and j.destination_id = d.id and j.status = 'sent'))
  on conflict (destination_id, install_id) where status = 'pending' do nothing
$$;

-- The triggers. Each is one lookup by project for a project without a destination. Whatever
-- goes wrong in here is reported as a warning and never fails the install or the event.
create function kma_internal.analytics_destinations_on_install() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_again boolean := true;
begin
  begin
    if exists (select 1 from public.analytics_destinations d where d.project_id = new.project_id) then
      if tg_op = 'UPDATE' then
        v_again := (old.method, old.source, old.campaign, old.creator_click)
          is distinct from (new.method, new.source, new.campaign, new.creator_click);
      end if;
      perform kma_internal.analytics_destinations_enqueue(new, v_again);
    end if;
  exception when others then
    raise warning 'Install % was not queued for analytics destinations (%)', new.id, sqlstate;
  end;
  return null;
end $$;
create trigger attribution_installs_destinations_insert
  after insert on public.attribution_installs
  for each row when (new.environment = 'production')
  execute function kma_internal.analytics_destinations_on_install();
-- A changed match is sent again. A new verdict, or the install moving to the signed-in person
-- it was folded into, sends it only when it was never sent.
create trigger attribution_installs_destinations_update
  after update of method, source, campaign, creator_click, verdict, person_id on public.attribution_installs
  for each row when (new.environment = 'production' and (
    old.method is distinct from new.method or old.source is distinct from new.source
    or old.campaign is distinct from new.campaign or old.creator_click is distinct from new.creator_click
    or old.verdict is distinct from new.verdict or old.person_id is distinct from new.person_id))
  execute function kma_internal.analytics_destinations_on_install();

-- A person identified after their install: the install goes out if it never did.
create function kma_internal.analytics_destinations_on_identify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if exists (select 1 from public.analytics_destinations d where d.project_id = new.project_id) then
      perform kma_internal.analytics_destinations_enqueue(i, false)
      from public.attribution_installs i where i.project_id = new.project_id and i.person_id = new.id;
    end if;
  exception when others then
    raise warning 'Person % was not queued for analytics destinations (%)', new.id, sqlstate;
  end;
  return null;
end $$;
create trigger analytics_people_destinations
  after update of user_id on public.analytics_people
  for each row when (old.user_id is null and new.user_id is not null)
  execute function kma_internal.analytics_destinations_on_identify();

-- Console (signed-in workspace members) -------------------------------------------------------

-- What the console shows of a project's destinations: never the key, only its last 4.
create function kma_internal.analytics_destinations_view(p_project uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('destinations', coalesce(jsonb_agg(jsonb_build_object(
      'provider', d.provider, 'region', d.region, 'key_last4', right(d.project_key, 4), 'status', d.status,
      'last_sent_at', d.last_sent_at, 'last_error', d.last_error,
      'sent_30d', (select count(*) from public.analytics_destination_jobs j
        where j.destination_id = d.id and j.status = 'sent' and j.finished_at > now() - interval '30 days'),
      'failed_30d', (select count(*) from public.analytics_destination_jobs j
        where j.destination_id = d.id and j.status = 'failed' and j.finished_at > now() - interval '30 days'))
    order by d.provider), '[]'::jsonb))
  from public.analytics_destinations d where d.project_id = p_project
$$;

-- Any member of the project's workspace reads it.
create function public.analytics_destinations_get(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project_id);
  return kma_internal.analytics_destinations_view(p_project_id);
end $$;

-- Saves a destination; developers and above. Input: the Amplitude project's API key (the field
-- named in v_field: 32 hex characters) and "region" ("us" | "eu"), both optional. The key is
-- needed the first time; after that a save without it keeps the saved key. Every save makes
-- the destination active again and sends what waits at once. Answer: the
-- analytics_destinations_get answer.
create function public.analytics_destination_save(p_project_id uuid, p_provider text, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_field constant text := 'api_' || 'key';
  v_key text;
  v_region text;
  v_now timestamptz := clock_timestamp();
  d public.analytics_destinations;
begin
  perform kma_internal.analytics_require_project(p_project_id, 'developer');
  if p_provider is distinct from 'amplitude' then
    perform kma_internal.program_fail('invalid_provider', 'Choose a supported analytics tool');
  end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k <> all(array[v_field, 'region'])) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  if jsonb_typeof(p_input->v_field) is distinct from 'null' and p_input ? v_field then
    v_key := lower(btrim(case when jsonb_typeof(p_input->v_field) = 'string' then p_input->>v_field end));
    if v_key is null or v_key !~ '^[0-9a-f]{32}$' then
      perform kma_internal.program_fail('invalid_key', 'Paste the API key of your Amplitude project: 32 letters and digits');
    end if;
  end if;
  if jsonb_typeof(p_input->'region') is distinct from 'null' and p_input ? 'region' then
    v_region := case when jsonb_typeof(p_input->'region') = 'string' then p_input->>'region' end;
    if v_region is null or v_region not in ('us', 'eu') then
      perform kma_internal.program_fail('invalid_region', 'Choose where your Amplitude data is kept: US or EU');
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('analytics-destination:' || p_project_id::text || ':' || p_provider, 0));
  -- No key update: an install queued meanwhile (its foreign key check) is never held up.
  select * into d from public.analytics_destinations x where x.project_id = p_project_id and x.provider = p_provider
  for no key update;
  if d.id is null then
    if v_key is null then
      perform kma_internal.program_fail('key_required', 'Paste the API key of your Amplitude project');
    end if;
    insert into public.analytics_destinations(project_id, provider, project_key, region, key_set_at,
      created_by, created_at, updated_by, updated_at)
    values (p_project_id, p_provider, v_key, coalesce(v_region, 'us'), v_now, auth.uid(), v_now, auth.uid(), v_now)
    returning * into d;
  else
    update public.analytics_destinations set
      project_key = coalesce(v_key, project_key), region = coalesce(v_region, region),
      key_set_at = case when v_key is not null then v_now else key_set_at end,
      status = 'active', last_error = null, last_error_at = null, updated_by = auth.uid(), updated_at = v_now
    where id = d.id returning * into d;
    update public.analytics_destination_jobs set next_attempt_at = v_now
    where destination_id = d.id and status = 'pending' and next_attempt_at > v_now;
  end if;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
  values (auth.uid(), 'system', 'analytics_destination_saved', 'analytics_destinations', d.id,
    jsonb_build_object('project_id', p_project_id, 'provider', d.provider, 'region', d.region,
      'key_last4', right(d.project_key, 4), 'key_changed', v_key is not null));
  return kma_internal.analytics_destinations_view(p_project_id);
end $$;

-- Removes a destination and what waits for it; developers and above. Removing one that is not
-- there changes nothing. Answer: the analytics_destinations_get answer.
create function public.analytics_destination_remove(p_project_id uuid, p_provider text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  d public.analytics_destinations;
begin
  perform kma_internal.analytics_require_project(p_project_id, 'developer');
  if p_provider is distinct from 'amplitude' then
    perform kma_internal.program_fail('invalid_provider', 'Choose a supported analytics tool');
  end if;
  delete from public.analytics_destinations x where x.project_id = p_project_id and x.provider = p_provider
  returning * into d;
  if d.id is not null then
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data)
    values (auth.uid(), 'system', 'analytics_destination_removed', 'analytics_destinations', d.id,
      jsonb_build_object('project_id', p_project_id, 'provider', d.provider, 'region', d.region,
        'key_last4', right(d.project_key, 4), 'sent_total', d.sent_total, 'failed_total', d.failed_total));
  end if;
  return kma_internal.analytics_destinations_view(p_project_id);
end $$;

-- Worker (service role: the analytics-destinations-worker edge function) ----------------------

-- One claimed job as the worker sends it.
create function kma_internal.analytics_destination_job_json(
  j public.analytics_destination_jobs, d public.analytics_destinations, i public.attribution_installs, p_user_id text
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', j.id, 'lease_token', j.lease_token, 'provider', d.provider, 'region', d.region,
    'api_' || 'key', d.project_key, 'user_id', p_user_id,
    -- Amplitude drops a second event with the same insert_id: a retry of this job is sent once.
    'insert_id', 'kma-' || j.id::text,
    'time', floor(extract(epoch from i.installed_at) * 1000)::bigint,
    'event_properties', jsonb_build_object('source', i.source, 'campaign', i.campaign, 'method', i.method,
      'exact', i.exact, 'platform', i.platform, 'creator', c.name),
    'user_properties', jsonb_build_object('kma_source', i.source, 'kma_campaign', i.campaign,
      'kma_method', i.method, 'kma_creator', c.name))
  from (select kma_internal.analytics_destination_creator(i) as name) c
$$;

-- Hands the worker due jobs, each with a lease: waiting, nobody holding it, its next try not
-- in the future, its destination not paused. Each claim counts an attempt. A job whose install
-- is no longer one to send (rejected since, say) is finished as skipped instead. A job whose
-- tenth attempt never came back is failed.
-- Input: {"limit": 1..500 (100), "lease_seconds": 30..600 (120)}.
-- Output: {"jobs": [{"id", "lease_token", "provider", "region", the project's key, "user_id",
--   "insert_id", "time" (epoch ms of the install), "event_properties": {"source", "campaign", "method", "exact",
--   "platform", "creator"}, "user_properties": {"kma_source", "kma_campaign", "kma_method",
--   "kma_creator"}}]}.
create function public.claim_analytics_destination_jobs(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input jsonb := coalesce(p, '{}'::jsonb);
  v_limit integer;
  v_lease integer;
  v_now timestamptz := clock_timestamp();
  v_jobs jsonb := '[]'::jsonb;
  r record;
  j public.analytics_destination_jobs;
begin
  if jsonb_typeof(v_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(v_input) k where k <> all(array['limit', 'lease_seconds']))
    or (v_input ? 'limit' and (jsonb_typeof(v_input->'limit') <> 'number' or v_input->>'limit' !~ '^[0-9]{1,3}$'
      or (v_input->>'limit')::integer not between 1 and 500))
    or (v_input ? 'lease_seconds' and (jsonb_typeof(v_input->'lease_seconds') <> 'number'
      or v_input->>'lease_seconds' !~ '^[0-9]{1,3}$' or (v_input->>'lease_seconds')::integer not between 30 and 600)) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  v_limit := coalesce((v_input->>'limit')::integer, 100);
  v_lease := coalesce((v_input->>'lease_seconds')::integer, 120);

  -- The tenth attempt never came back: given up.
  with gone as (
    update public.analytics_destination_jobs x set status = 'failed', last_error = coalesce(x.last_error, 'lease_expired'),
      finished_at = v_now, lease_token = null, lease_until = null
    where x.status = 'pending' and x.attempts >= 10 and x.lease_until < v_now
    returning x.destination_id)
  update public.analytics_destinations d set failed_total = d.failed_total + g.n,
    status = case when d.status = 'paused' then 'paused' else 'failing' end,
    last_error = 'lease_expired', last_error_at = v_now
  from (select destination_id, count(*) as n from gone group by destination_id) g
  where d.id = g.destination_id;

  for r in
    select x.id, d, i, pe.user_id
    from public.analytics_destination_jobs x
    join public.analytics_destinations d on d.id = x.destination_id and d.status in ('active', 'failing')
    join public.attribution_installs i on i.id = x.install_id
    join public.analytics_people pe on pe.id = i.person_id
    where x.status = 'pending' and x.attempts < 10 and x.next_attempt_at <= v_now
      and (x.lease_until is null or x.lease_until < v_now)
    order by x.next_attempt_at, x.created_at, x.id
    limit v_limit
    for update of x skip locked
  loop
    if not kma_internal.analytics_destination_sendable(r.i) or r.user_id is null or (r.i).project_id <> (r.d).project_id then
      update public.analytics_destination_jobs set status = 'skipped', finished_at = v_now, lease_token = null,
        lease_until = null
      where id = r.id;
      continue;
    end if;
    update public.analytics_destination_jobs set attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => v_lease), claimed_at = v_now
    where id = r.id returning * into j;
    v_jobs := v_jobs || jsonb_build_array(kma_internal.analytics_destination_job_json(j, r.d, r.i, r.user_id));
  end loop;
  return jsonb_build_object('jobs', v_jobs);
end $$;

-- Ends the worker's hold on a job. Input, always with the claim's id and lease_token:
--   {"ok": true}: Amplitude took it. The destination is active again if it was failing.
--   {"error": "invalid_key"}: Amplitude refused the key. The destination is paused (unless the
--     key was saved again since the claim) and the job waits, its attempt not counted.
--   {"error": <code>, "retry": true, "delay_seconds"?: 5..86400}: tried again after the delay,
--     or 1, 2, 4 ... minutes (at most 6 hours); failed after the 10th attempt.
--   {"error": <code>, "retry": false}: failed now (Amplitude refused the event itself).
--   {"release": true}: the worker never sent it; back on the queue, its attempt not counted.
-- Codes are short and stable (^[a-z][a-z0-9_]{1,59}$), never Amplitude's text.
-- Output: {"id", "status": "sent" | "pending" | "failed", "next_attempt_at", "destination_status"}.
create function public.finish_analytics_destination_job(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_lease uuid;
  v_error text;
  v_retry boolean;
  v_delay integer;
  v_now timestamptz := clock_timestamp();
  j public.analytics_destination_jobs;
  d public.analytics_destinations;
begin
  if jsonb_typeof(p) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(p) k
      where k <> all(array['id', 'lease_token', 'ok', 'error', 'retry', 'delay_seconds', 'release'])) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  v_id := kma_internal.workspace_stripe_uuid(p->>'id');
  v_lease := kma_internal.workspace_stripe_uuid(p->>'lease_token');
  v_error := case when jsonb_typeof(p->'error') = 'string' then p->>'error' end;
  v_retry := case when jsonb_typeof(p->'retry') = 'boolean' then (p->>'retry')::boolean end;
  if p ? 'delay_seconds' then
    v_delay := case when jsonb_typeof(p->'delay_seconds') = 'number' and p->>'delay_seconds' ~ '^[0-9]{1,5}$'
      then (p->>'delay_seconds')::integer else -1 end;
  end if;
  if v_id is null or v_lease is null
    or (select count(*) from jsonb_object_keys(p) k where k in ('ok', 'error', 'release')) <> 1
    or (p ? 'ok' and p->'ok' <> 'true'::jsonb)
    or (p ? 'release' and p->'release' <> 'true'::jsonb)
    or (p ? 'error' and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{1,59}$'))
    or (p ? 'retry' and (v_retry is null or not p ? 'error' or v_error = 'invalid_key'))
    or (p ? 'error' and v_error <> 'invalid_key' and v_retry is null)
    or (v_delay is not null and (v_retry is distinct from true or v_delay not between 5 and 86400)) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  -- The destination first, then the job, as removing a destination takes them; no key update,
  -- so an install queued meanwhile (its foreign key check) is never held up.
  select * into d from public.analytics_destinations x
  where x.id = (select y.destination_id from public.analytics_destination_jobs y where y.id = v_id)
  for no key update;
  select * into j from public.analytics_destination_jobs x where x.id = v_id for update;
  if j.id is null or d.id is null then
    perform kma_internal.program_fail('job_not_found', 'Job not found', 'P0002');
  end if;
  if j.status <> 'pending' or j.lease_token is distinct from v_lease or j.lease_until <= v_now then
    perform kma_internal.program_fail('lease_lost', 'This job is no longer held by the caller');
  end if;

  if p ? 'ok' then
    update public.analytics_destination_jobs set status = 'sent', finished_at = v_now, last_error = null,
      lease_token = null, lease_until = null
    where id = j.id returning * into j;
    update public.analytics_destinations set last_sent_at = v_now, sent_total = sent_total + 1,
      status = case when status = 'failing' then 'active' else status end,
      last_error = case when status = 'failing' then null else last_error end,
      last_error_at = case when status = 'failing' then null else last_error_at end
    where id = d.id returning * into d;
  elsif p ? 'release' then
    update public.analytics_destination_jobs set attempts = greatest(attempts - 1, 0), lease_token = null,
      lease_until = null
    where id = j.id returning * into j;
  elsif v_error = 'invalid_key' then
    update public.analytics_destination_jobs set attempts = greatest(attempts - 1, 0), lease_token = null,
      lease_until = null, last_error = v_error, next_attempt_at = v_now
    where id = j.id returning * into j;
    if d.key_set_at <= j.claimed_at then
      update public.analytics_destinations set status = 'paused', last_error = v_error, last_error_at = v_now
      where id = d.id returning * into d;
    end if;
  elsif v_retry and j.attempts < 10 then
    update public.analytics_destination_jobs set lease_token = null, lease_until = null, last_error = v_error,
      next_attempt_at = v_now + make_interval(secs => coalesce(v_delay,
        least(21600, 60 * power(2, greatest(j.attempts, 1) - 1))::integer))
    where id = j.id returning * into j;
    update public.analytics_destinations set status = case when status = 'paused' then 'paused' else 'failing' end,
      last_error = v_error, last_error_at = v_now
    where id = d.id returning * into d;
  else
    update public.analytics_destination_jobs set status = 'failed', finished_at = v_now, last_error = v_error,
      lease_token = null, lease_until = null
    where id = j.id returning * into j;
    update public.analytics_destinations set failed_total = failed_total + 1,
      status = case when status = 'paused' then 'paused' else 'failing' end,
      last_error = v_error, last_error_at = v_now
    where id = d.id returning * into d;
  end if;
  return jsonb_build_object('id', j.id, 'status', j.status,
    'next_attempt_at', case when j.status = 'pending' then j.next_attempt_at end, 'destination_status', d.status);
end $$;

-- Schedule ---------------------------------------------------------------------------------
-- Run once a minute by pg_cron (job kma-analytics-destinations). It calls the worker only when
-- a job is due, and otherwise not at all. Disabled until enabled is set. The migration installs
-- no cron job and no Vault value (docs/affiliate-self-serve-phase8-deploy.md, "D. Amplitude").
create table kma_internal.analytics_destination_schedule (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  last_tick_at timestamptz,
  last_dispatch_at timestamptz,
  last_request_id bigint
);
insert into kma_internal.analytics_destination_schedule default values;
revoke all on kma_internal.analytics_destination_schedule from public, anon, authenticated, service_role;

create function kma_internal.tick_analytics_destination_schedule() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_schedule kma_internal.analytics_destination_schedule;
  v_value text;
  v_request bigint;
  v_now timestamptz := clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-analytics-destination-scheduler', 0)) then
    return jsonb_build_object('status', 'locked');
  end if;
  update kma_internal.analytics_destination_schedule set last_tick_at = v_now where singleton
    returning * into v_schedule;
  if not v_schedule.enabled then
    return jsonb_build_object('status', 'paused');
  end if;
  if not exists (select 1 from public.analytics_destination_jobs j
    join public.analytics_destinations d on d.id = j.destination_id and d.status in ('active', 'failing')
    where j.status = 'pending' and j.next_attempt_at <= v_now and (j.lease_until is null or j.lease_until < v_now)) then
    return jsonb_build_object('status', 'idle');
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where name = 'kma_analytics_destinations_scheduler';
  if v_value is null or length(v_value) < 32 then
    return jsonb_build_object('status', 'scheduler_value_missing');
  end if;
  v_request := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/analytics-destinations-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kma-scheduler-secret', v_value),
    timeout_milliseconds := 80000);
  update kma_internal.analytics_destination_schedule
    set last_dispatch_at = clock_timestamp(), last_request_id = v_request where singleton;
  return jsonb_build_object('status', 'dispatched');
end $$;

-- Access -----------------------------------------------------------------------------------
revoke all on function
    kma_internal.analytics_destination_sendable(public.attribution_installs),
    kma_internal.analytics_destination_creator(public.attribution_installs),
    kma_internal.analytics_destinations_enqueue(public.attribution_installs, boolean),
    kma_internal.analytics_destinations_on_install(),
    kma_internal.analytics_destinations_on_identify(),
    kma_internal.analytics_destinations_view(uuid),
    kma_internal.analytics_destination_job_json(public.analytics_destination_jobs, public.analytics_destinations,
      public.attribution_installs, text),
    kma_internal.tick_analytics_destination_schedule()
  from public, anon, authenticated, service_role;
revoke all on function
    public.analytics_destinations_get(uuid), public.analytics_destination_save(uuid, text, jsonb),
    public.analytics_destination_remove(uuid, text),
    public.claim_analytics_destination_jobs(jsonb), public.finish_analytics_destination_job(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
    public.analytics_destinations_get(uuid), public.analytics_destination_save(uuid, text, jsonb),
    public.analytics_destination_remove(uuid, text)
  to authenticated;
grant execute on function
    public.claim_analytics_destination_jobs(jsonb), public.finish_analytics_destination_job(jsonb)
  to service_role;

commit;

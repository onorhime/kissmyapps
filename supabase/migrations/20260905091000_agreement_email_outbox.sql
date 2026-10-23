begin;

create table kma_internal.agreement_email_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  event_type text not null check (event_type in ('signing_request','partner_signed','agreement_fully_signed')),
  recipient_user_id uuid,
  recipient_email text,
  context jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','cancelled','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  envelope jsonb,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  sent_at timestamptz,
  unique nulls not distinct (document_id,event_type,recipient_user_id)
);
alter table kma_internal.agreement_email_jobs enable row level security;
revoke all on kma_internal.agreement_email_jobs from public, anon, authenticated, service_role;
create index agreement_email_jobs_pending on kma_internal.agreement_email_jobs (next_attempt_at)
  where status in ('pending','processing');

-- This trigger ONLY writes a durable job in the signature transaction.
-- No HTTP request, Resend call, or secret lookup can roll back the signature.
create or replace function public.notify_agreement_document_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_type_value text; context_value jsonb; recipients integer;
begin
  if new.document_type <> 'partner_agreement' then return new; end if;
  if tg_op = 'INSERT' and new.status = 'awaiting_partner_signature' then
    event_type_value := 'signing_request';
  elsif tg_op = 'UPDATE' then
    if new.status = 'awaiting_kissmyapps_signature' and old.status = 'awaiting_partner_signature' then
      event_type_value := 'partner_signed';
    elsif new.status = 'signed' and old.status = 'awaiting_kissmyapps_signature' then
      event_type_value := 'agreement_fully_signed';
    end if;
  end if;
  if event_type_value is null then return new; end if;
  select jsonb_build_object('productName',p.name,'partnerName',af.public_name,
    'agreementVersion',a.version,'documentVersion',new.version)
    into context_value from public.agreements a
    join public.products p on p.id = a.product_id
    join public.affiliates af on af.id = a.affiliate_id where a.id = new.agreement_id;
  insert into kma_internal.agreement_email_jobs
    (document_id,event_type,recipient_user_id,recipient_email,context)
  select new.id,event_type_value,u.id,u.email,context_value from auth.users u
  where u.email is not null and u.email_confirmed_at is not null and (
    (event_type_value = 'partner_signed' and exists (
      select 1 from public.admin_users m where m.user_id=u.id and m.active and m.role in ('owner','operations')
    )) or (event_type_value <> 'partner_signed' and exists (
      select 1 from public.affiliate_users m join public.affiliates af on af.id=m.affiliate_id
      where m.user_id=u.id and m.affiliate_id=new.affiliate_id and m.active and m.role='owner' and af.status='active'
    ))
  ) on conflict do nothing;
  get diagnostics recipients = row_count;
  if recipients = 0 then
    insert into kma_internal.agreement_email_jobs (document_id,event_type,context,status,last_error)
    values (new.id,event_type_value,context_value,'failed','no_verified_recipient') on conflict do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.claim_agreement_email_jobs(p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 3 then raise exception 'invalid claim limit' using errcode='22023'; end if;
  -- Re-check the intended recipient at delivery, not only at enqueue. Never
  -- silently redirect an old frozen envelope after an email or role change.
  update kma_internal.agreement_email_jobs j set status='cancelled',last_error='recipient_no_longer_authorized'
  where j.status in ('pending','processing') and (j.lease_until is null or j.lease_until<now())
    and not exists (select 1 from auth.users u where u.id=j.recipient_user_id
      and u.email=j.recipient_email and u.email_confirmed_at is not null and (
        (j.event_type='partner_signed' and exists(select 1 from public.admin_users m
          where m.user_id=u.id and m.active and m.role in ('owner','operations'))) or
        (j.event_type<>'partner_signed' and exists(select 1 from public.affiliate_users m
          join public.affiliates a on a.id=m.affiliate_id
          join public.documents d on d.affiliate_id=m.affiliate_id and d.id=j.document_id
          where m.user_id=u.id and m.active and m.role='owner' and a.status='active'))));
  -- Retire stale requests before leasing. A revoked/deleted/advanced document
  -- must not produce a fresh signing invitation or countersigning reminder.
  update kma_internal.agreement_email_jobs j set status='cancelled',last_error='milestone_superseded'
  where j.status in ('pending','processing') and (j.lease_until is null or j.lease_until < now())
    and not exists (select 1 from public.documents d where d.id=j.document_id and (
      (j.event_type='signing_request' and d.status='awaiting_partner_signature') or
      (j.event_type='partner_signed' and d.status='awaiting_kissmyapps_signature') or
      (j.event_type='agreement_fully_signed' and d.status in ('signed','active'))));
  -- Resend keys expire after 24h. Never automatically retry an ambiguous
  -- delivery outside the deduplication window; require operator investigation.
  update kma_internal.agreement_email_jobs set status='failed',last_error='retry_window_exhausted'
  where status in ('pending','processing') and (lease_until is null or lease_until < now())
    and (attempts >= 8 or first_attempt_at < now()-interval '20 hours');
  with candidates as (
    select id from kma_internal.agreement_email_jobs
    where status in ('pending','processing') and next_attempt_at <= now()
      and (lease_until is null or lease_until < now())
    order by created_at,id for update skip locked limit p_limit
  ), claimed as (
    update kma_internal.agreement_email_jobs j set status='processing',attempts=j.attempts+1,
      lease_until=now()+interval '2 minutes',claim_token=gen_random_uuid(),
      first_attempt_at=coalesce(j.first_attempt_at,now())
    from candidates c where j.id=c.id returning j.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'claimToken',claim_token,
    'type',event_type,'to',recipient_email,'context',context,'envelope',envelope)), '[]'::jsonb)
    into result from claimed;
  return result;
end;
$$;

create or replace function public.seal_agreement_email_job(p_id uuid,p_claim_token uuid,p_envelope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job kma_internal.agreement_email_jobs%rowtype;
begin
  select * into job from kma_internal.agreement_email_jobs where id=p_id for update;
  if job.id is null or job.status<>'processing' or job.claim_token is distinct from p_claim_token
    or job.lease_until < now() then raise exception 'email claim expired' using errcode='P0001'; end if;
  if job.envelope is not null then return job.envelope; end if;
  if jsonb_typeof(p_envelope) is distinct from 'object'
    or not (p_envelope ?& array['from','to','subject','html'])
    or (select count(*) from jsonb_object_keys(p_envelope)) <> 4
    or p_envelope->>'to' is distinct from job.recipient_email
    or jsonb_typeof(p_envelope->'from') is distinct from 'string'
    or jsonb_typeof(p_envelope->'subject') is distinct from 'string'
    or jsonb_typeof(p_envelope->'html') is distinct from 'string'
    or octet_length(p_envelope::text)>65536 then
    raise exception 'invalid email envelope' using errcode='22023';
  end if;
  update kma_internal.agreement_email_jobs set envelope=p_envelope where id=job.id;
  return p_envelope;
end;
$$;

create or replace function public.finish_agreement_email_job(
  p_id uuid,p_claim_token uuid,p_provider_id text default null,p_error text default null,p_retryable boolean default false
)
returns void language plpgsql security definer set search_path = '' as $$
declare job kma_internal.agreement_email_jobs%rowtype;
begin
  select * into job from kma_internal.agreement_email_jobs where id=p_id for update;
  if job.id is null or job.status<>'processing' or job.claim_token is distinct from p_claim_token then
    raise exception 'email claim expired' using errcode='P0001';
  end if;
  if p_provider_id is not null and p_provider_id !~ '^[A-Za-z0-9_-]{1,160}$' then
    raise exception 'invalid provider receipt' using errcode='22023';
  end if;
  if p_error is not null and p_error !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'invalid delivery error' using errcode='22023';
  end if;
  if (p_provider_id is null) = (p_error is null) then
    raise exception 'one delivery outcome is required' using errcode='22023';
  end if;
  update kma_internal.agreement_email_jobs set
    status=case when p_provider_id is not null then 'sent'
      when p_retryable and attempts<8 and first_attempt_at>now()-interval '20 hours' then 'pending' else 'failed' end,
    sent_at=case when p_provider_id is not null then now() else null end,
    provider_id=p_provider_id,last_error=p_error,lease_until=null,claim_token=null,
    next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer))
  where id=job.id;
end;
$$;

-- Read-only operational visibility, without exposing recipient emails or PDFs.
create or replace function public.get_admin_agreement_email_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin_password(array['owner','operations']::text[], 'view agreement email health');
  return (select jsonb_build_object('pending',count(*) filter(where status='pending'),
    'processing',count(*) filter(where status='processing'),'failed',count(*) filter(where status='failed'),
    'sent',count(*) filter(where status='sent'), 'oldest_pending_at',min(created_at) filter(where status='pending'))
    from kma_internal.agreement_email_jobs);
end;
$$;

create or replace function kma_internal.dispatch_agreement_email_jobs()
returns bigint language plpgsql security definer set search_path = '' as $$
declare credential text; request_id bigint;
begin
  if not exists (select 1 from kma_internal.agreement_email_jobs where status in ('pending','processing')
    and next_attempt_at<=now() and (lease_until is null or lease_until<now())) then return null; end if;
  select value into credential from kma_internal.function_secrets where name='agreement_notify';
  if credential is null or length(credential)<32 then raise exception 'notification credential is not provisioned'; end if;
  select net.http_post(
    url:='https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/agreement-notify',
    body:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','x-kma-internal-secret',credential),
    timeout_milliseconds:=10000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.claim_agreement_email_jobs(integer),public.seal_agreement_email_job(uuid,uuid,jsonb),
  public.finish_agreement_email_job(uuid,uuid,text,text,boolean),public.get_admin_agreement_email_health(),
  kma_internal.dispatch_agreement_email_jobs() from public,anon,authenticated,service_role;
grant execute on function public.claim_agreement_email_jobs(integer),public.seal_agreement_email_job(uuid,uuid,jsonb),
  public.finish_agreement_email_job(uuid,uuid,text,text,boolean) to service_role;
grant execute on function public.get_admin_agreement_email_health() to authenticated;

-- Scheduling is activated by the release runbook only after the new worker and
-- rotated credential are deployed. No HTTP jobs run from this migration.
commit;

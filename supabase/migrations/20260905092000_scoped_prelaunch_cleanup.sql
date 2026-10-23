begin;

-- Only the approved deletion RPC can create a transaction-scoped exception.
create table kma_internal.product_deletion_scopes (
  transaction_id bigint not null, backend_pid integer not null, product_id uuid not null,
  primary key(transaction_id,backend_pid,product_id)
);
alter table kma_internal.product_deletion_scopes enable row level security;
revoke all on kma_internal.product_deletion_scopes from public,anon,authenticated,service_role;
create or replace function public.guard_tracking_history_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='DELETE' and not old.commercial_eligible and exists (
    select 1 from kma_internal.product_deletion_scopes s
    where s.transaction_id=txid_current() and s.backend_pid=pg_backend_pid() and s.product_id=old.product_id
  ) then return old; end if;
  raise exception 'tracking history is append-only outside an approved non-commercial product deletion' using errcode='P0001';
end;
$$;
drop trigger clicks_are_append_only on public.clicks;
drop trigger events_are_append_only on public.events;
create trigger clicks_are_append_only before update or delete on public.clicks
  for each row execute function public.guard_tracking_history_mutation();
create trigger events_are_append_only before update or delete on public.events
  for each row execute function public.guard_tracking_history_mutation();

create table kma_internal.document_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  file_path text not null unique,
  object_id uuid not null,
  requested_by uuid,
  status text not null default 'pending' check(status in ('pending','processing','done','failed')),
  attempts integer not null default 0,
  claim_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
alter table kma_internal.document_cleanup_jobs enable row level security;
revoke all on kma_internal.document_cleanup_jobs from public,anon,authenticated,service_role;

create or replace function kma_internal.queue_document_cleanup(p_file_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare obj storage.objects%rowtype;
begin
  select * into obj from storage.objects where bucket_id='affiliate-private-documents' and name=p_file_path for update;
  if obj.id is null then return; end if;
  if exists(select 1 from public.documents where file_path=p_file_path)
    or exists(select 1 from public.payouts where statement_storage_path=p_file_path) then
    raise exception 'referenced document files cannot be removed' using errcode='P0001';
  end if;
  insert into kma_internal.document_cleanup_jobs(file_path,object_id,requested_by)
    values(p_file_path,obj.id,auth.uid()) on conflict(file_path) do nothing;
end;
$$;
create or replace function public.request_admin_document_cleanup(p_file_path text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin_password(array['owner','operations']::text[],'clean up an unused document');
  if p_file_path is null or length(p_file_path)>1024 or position('..' in p_file_path)>0
    or not exists(select 1 from public.affiliates a where p_file_path like a.id::text || '/agreements/%') then
    raise exception 'invalid document cleanup path' using errcode='22023';
  end if;
  perform kma_internal.queue_document_cleanup(p_file_path);
end;
$$;
create or replace function public.queue_deleted_document_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.documents where file_path=old.file_path)
    and not exists(select 1 from public.payouts where statement_storage_path=old.file_path) then
    perform kma_internal.queue_document_cleanup(old.file_path);
  end if;
  return old;
end;
$$;
create trigger documents_queue_file_cleanup after delete on public.documents
  for each row execute function public.queue_deleted_document_cleanup();

-- Lock the object before checking tombstones. An object queued for removal can
-- never be attached later, even if the Storage HTTP deletion is still pending.
create or replace function public.guard_document_cleanup_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from storage.objects where bucket_id='affiliate-private-documents' and name=new.file_path for update;
  if exists(select 1 from kma_internal.document_cleanup_jobs where file_path=new.file_path) then
    raise exception 'this file is queued for cleanup; upload a new PDF' using errcode='P0001';
  end if;
  return new;
end;
$$;
create trigger documents_00_cleanup_guard before insert or update of file_path on public.documents
  for each row execute function public.guard_document_cleanup_reference();

create or replace function public.claim_document_cleanup_jobs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  update kma_internal.document_cleanup_jobs j set status='failed',last_error='object_referenced_or_replaced'
  where j.status in ('pending','processing') and (lease_until is null or lease_until<now()) and (
    exists(select 1 from public.documents d where d.file_path=j.file_path) or
    exists(select 1 from public.payouts p where p.statement_storage_path=j.file_path) or
    exists(select 1 from storage.objects o where o.bucket_id='affiliate-private-documents' and o.name=j.file_path and o.id<>j.object_id)
  );
  update kma_internal.document_cleanup_jobs j set status='done',last_error=null
  where j.status in ('pending','processing') and (lease_until is null or lease_until<now())
    and not exists(select 1 from storage.objects o where o.bucket_id='affiliate-private-documents' and o.name=j.file_path);
  update kma_internal.document_cleanup_jobs set status='failed',last_error='retry_limit'
  where status in ('pending','processing') and attempts>=8 and (lease_until is null or lease_until<now());
  with selected as (
    select id from kma_internal.document_cleanup_jobs where status in ('pending','processing')
      and next_attempt_at<=now() and (lease_until is null or lease_until<now())
    order by created_at,id for update skip locked limit 3
  ), claimed as (
    update kma_internal.document_cleanup_jobs j set status='processing',attempts=j.attempts+1,
      claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
    from selected s where j.id=s.id returning j.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'claimToken',claim_token,'filePath',file_path)),'[]'::jsonb)
    into result from claimed;
  return result;
end;
$$;
create or replace function public.finish_document_cleanup_job(p_id uuid,p_claim_token uuid,p_success boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update kma_internal.document_cleanup_jobs set status=case when p_success then 'done' when attempts<8 then 'pending' else 'failed' end,
    claim_token=null,lease_until=null,next_attempt_at=now()+interval '5 minutes',
    last_error=case when p_success then null else 'storage_delete_failed' end
  where id=p_id and claim_token=p_claim_token and status='processing';
  if not found then raise exception 'cleanup claim expired' using errcode='P0001'; end if;
end;
$$;
revoke all on function public.guard_tracking_history_mutation(),kma_internal.queue_document_cleanup(text),
  public.request_admin_document_cleanup(text),public.queue_deleted_document_cleanup(),
  public.guard_document_cleanup_reference(),public.claim_document_cleanup_jobs(),public.finish_document_cleanup_job(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.request_admin_document_cleanup(text) to authenticated;
grant execute on function public.claim_document_cleanup_jobs(),public.finish_document_cleanup_job(uuid,uuid,boolean) to service_role;

create or replace function public.get_admin_agreement_email_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin_password(array['owner','operations']::text[], 'view agreement email health');
  return (select jsonb_build_object('pending',count(*) filter(where status='pending'),
    'processing',count(*) filter(where status='processing'),'failed',count(*) filter(where status='failed'),
    'sent',count(*) filter(where status='sent'),'oldest_pending_at',min(created_at) filter(where status='pending'))
    from kma_internal.agreement_email_jobs) ||
    (select jsonb_build_object('cleanup_pending',count(*) filter(where status='pending'),
    'cleanup_processing',count(*) filter(where status='processing'),'cleanup_failed',count(*) filter(where status='failed'),
    'cleanup_done',count(*) filter(where status='done')) from kma_internal.document_cleanup_jobs);
end;
$$;

create or replace function public.delete_admin_product(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['product_id', 'confirmation'];
  product_id_value uuid;
  confirmation_value text;
  product_record public.products%rowtype;
  stored public.products%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'delete a product');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'delete input must contain exactly product_id and confirmation' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'confirmation') <> 'string' then
    raise exception 'delete input values are invalid' using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  confirmation_value := trim(p_input ->> 'confirmation');

  select * into product_record
  from public.products as product
  where product.id = product_id_value
  for update;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if confirmation_value <> product_record.slug then
    raise exception 'type the exact product slug to confirm deletion' using errcode = '22023';
  end if;

  -- Real commercial facts make a product permanent history.
  if exists (select 1 from public.checkout_attempts as row where row.product_id = product_record.id)
     or exists (select 1 from public.subscriptions as row where row.product_id = product_record.id)
     or exists (select 1 from public.entitlements as row where row.product_id = product_record.id)
     or exists (select 1 from public.conversions as row where row.product_id = product_record.id)
     or exists (select 1 from public.commission_entries as row where row.product_id = product_record.id)
     or exists (select 1 from public.payouts as row where row.product_id = product_record.id)
     or exists (select 1 from public.commercial_transaction_states as row where row.product_id = product_record.id)
     or exists (select 1 from public.commercial_source_applications as row where row.product_id = product_record.id)
     or exists (
       select 1 from public.events as row
       where row.product_id = product_record.id and row.commercial_eligible
     )
     or exists (
       select 1 from public.affiliate_daily_metrics as row
       where row.product_id = product_record.id
         and (
           row.purchases <> 0 or row.renewals <> 0 or row.cancellations <> 0
           or row.activations <> 0 or row.refunds <> 0 or row.disputes <> 0
           or row.gross_collected_minor <> 0 or row.eligible_revenue_minor <> 0
           or row.earnings_minor <> 0 or row.active_subscriptions <> 0
           or row.is_subscription_snapshot
         )
     ) then
    raise exception 'this product already has commercial records (purchases, commissions, payouts, or entitlements) and cannot be deleted'
      using errcode = 'P0001';
  end if;

  -- Preserved bilateral evidence blocks deletion like any commercial record.
  if exists (
    select 1 from public.documents as document
    join public.agreements as agreement on agreement.id = document.agreement_id
    where agreement.product_id = product_record.id
      and document.status in ('signed', 'active')
  ) then
    raise exception 'a fully signed agreement document for this product is preserved as evidence and cannot be deleted'
      using errcode = 'P0001';
  end if;

  if exists(select 1 from public.clicks where product_id=product_record.id and commercial_eligible) then
    raise exception 'commercial tracking history must be retained; archive this product instead' using errcode='P0001';
  end if;
  insert into kma_internal.product_deletion_scopes values(txid_current(),pg_backend_pid(),product_record.id);
  delete from public.affiliate_daily_metrics as row
  where row.product_id = product_record.id;
  delete from public.commercial_metric_refresh_queue as row
  where row.product_id = product_record.id;
  delete from public.events as row
  where row.product_id = product_record.id;
  delete from public.acquisitions as row
  where row.product_id = product_record.id;
  delete from public.clicks as row
  where row.product_id = product_record.id;
  delete from public.affiliate_links as row
  where row.product_id = product_record.id;
  delete from public.documents as document
  where document.agreement_id in (
    select agreement.id from public.agreements as agreement
    where agreement.product_id = product_record.id
  );
  delete from public.commission_rules as rule
  where rule.agreement_id in (
    select agreement.id from public.agreements as agreement
    where agreement.product_id = product_record.id
  );
  delete from public.agreements as row
  where row.product_id = product_record.id;
  delete from public.billing_offers as row
  where row.product_id = product_record.id;
  delete from public.campaigns as row
  where row.product_id = product_record.id;
  update public.products set tracking_mode='commercial',tracking_only_funnel_id=null,
    tracking_only_destination_url_snapshot=null,tracking_only_approved_by=null,tracking_only_approved_at=null
  where id=product_record.id;
  delete from public.funnels as row
  where row.product_id = product_record.id;
  delete from public.products as row
  where row.id = product_record.id
  returning * into stored;

  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id, metadata
  ) values (
    auth.uid(), 'admin', 'product.delete', 'products', stored.id,
    jsonb_build_object('slug', stored.slug, 'name', stored.name)
  );

  delete from kma_internal.product_deletion_scopes
  where transaction_id=txid_current() and backend_pid=pg_backend_pid() and product_id=product_record.id;
  return to_jsonb(stored);
end;
$$;

create or replace function public.protect_billing_offer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_state public.product_status;
begin
  if tg_op = 'DELETE' then
    if exists(select 1 from kma_internal.product_deletion_scopes s
      where s.transaction_id=txid_current() and s.backend_pid=pg_backend_pid() and s.product_id=old.product_id) then
      return old;
    end if;
    raise exception 'billing offers are retained for commercial history' using errcode = 'P0001';
  end if;

  select product.status into product_state
  from public.products as product
  where product.id = new.product_id
  for share;

  if product_state is null then
    raise exception 'billing offer requires a product' using errcode = '23514';
  end if;
  if new.status = 'active' and product_state <> 'active' then
    raise exception 'an active billing offer requires an active product' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.product_id <> old.product_id
       or new.key <> old.key
       or new.version <> old.version
       or new.created_at <> old.created_at then
      raise exception 'billing offer identity is immutable' using errcode = 'P0001';
    end if;
    if old.status <> 'draft' and (
      new.name <> old.name
      or new.billing_mode <> old.billing_mode
      or new.stripe_price_id is distinct from old.stripe_price_id
      or new.currency is distinct from old.currency
      or new.unit_amount_minor is distinct from old.unit_amount_minor
      or new.success_url_template is distinct from old.success_url_template
      or new.cancel_url is distinct from old.cancel_url
    ) then
      raise exception 'activated billing terms are immutable; create a new offer version' using errcode = 'P0001';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('draft', 'active', 'archived'))
      or (old.status = 'active' and new.status in ('active', 'paused', 'archived'))
      or (old.status = 'paused' and new.status in ('paused', 'active', 'archived'))
      or (old.status = 'archived' and new.status = 'archived')
    ) then
      raise exception 'invalid billing offer status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
  elsif new.status not in ('draft', 'active') then
    raise exception 'new billing offers must be draft or active' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function kma_internal.dispatch_agreement_email_jobs()
returns bigint language plpgsql security definer set search_path = '' as $$
declare credential text; request_id bigint;
begin
  if not exists (select 1 from kma_internal.agreement_email_jobs where status in ('pending','processing')
    and next_attempt_at<=now() and (lease_until is null or lease_until<now())) and not exists (
    select 1 from kma_internal.document_cleanup_jobs where status in ('pending','processing')
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

commit;

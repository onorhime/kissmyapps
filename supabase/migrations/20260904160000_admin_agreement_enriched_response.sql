-- Agreement mutations must return the same enriched agreement JSON that the
-- strict browser mapper requires (signed-document state, launch readiness,
-- partner identity, current document, and rules) instead of a bare table row.
-- The destination-redaction release already established this shape for the
-- configuration read; this aligns the create/activate mutation responses.

create or replace function public.admin_agreement_enriched(p_agreement public.agreements)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p_agreement) || jsonb_build_object(
    'partner_name', (
      select affiliate.public_name
      from public.affiliates as affiliate
      where affiliate.id = p_agreement.affiliate_id
    ),
    'partner_slug', (
      select affiliate.slug
      from public.affiliates as affiliate
      where affiliate.id = p_agreement.affiliate_id
    ),
    'has_signed_document', exists (
      select 1 from public.documents as document
      where document.agreement_id = p_agreement.id
        and document.affiliate_id = p_agreement.affiliate_id
        and document.status in ('signed', 'active')
        and document.signed_by_partner_at is not null
        and document.signed_by_partner_at <= now()
        and document.signed_by_kissmyapps_at is not null
        and document.signed_by_kissmyapps_at <= now()
        and (document.effective_at is null or document.effective_at <= now())
        and (document.expires_at is null or document.expires_at > now())
        and document.terminated_at is null
    ),
    'launch_ready', public.agreement_is_launch_ready(p_agreement.id, now()),
    'document', (
      select to_jsonb(document)
      from public.documents as document
      where document.agreement_id = p_agreement.id
        and document.affiliate_id = p_agreement.affiliate_id
        and document.status in ('awaiting_partner_signature', 'awaiting_kissmyapps_signature', 'signed')
      order by document.created_at desc, document.id
      limit 1
    ),
    'rules', coalesce((
      select jsonb_agg(to_jsonb(rule) order by rule.version, rule.id)
      from public.commission_rules as rule
      where rule.agreement_id = p_agreement.id
    ), '[]'::jsonb)
  )
$$;

revoke all on function public.admin_agreement_enriched(public.agreements)
  from public, anon, authenticated, service_role;

create or replace function public.create_admin_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'affiliate_id', 'product_id', 'model', 'attribution_window_days',
    'renewal_duration_days', 'payout_frequency_days', 'payout_currency',
    'minimum_payout_minor'
  ];
  affiliate_id_value uuid;
  product_id_value uuid;
  next_version integer;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create agreements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if not (p_input ? 'affiliate_id') or not (p_input ? 'product_id')
     or not (p_input ? 'model') or not (p_input ? 'payout_currency') then
    raise exception 'affiliate_id, product_id, model, and payout_currency are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'model') <> 'string'
     or jsonb_typeof(p_input -> 'payout_currency') <> 'string' then
    raise exception 'agreement input values are invalid' using errcode = '22023';
  end if;
  if (p_input ? 'attribution_window_days'
      and jsonb_typeof(p_input -> 'attribution_window_days') not in ('number', 'null'))
     or (p_input ? 'renewal_duration_days'
         and jsonb_typeof(p_input -> 'renewal_duration_days') not in ('number', 'null'))
     or (p_input ? 'payout_frequency_days'
         and jsonb_typeof(p_input -> 'payout_frequency_days') not in ('number', 'null'))
     or (p_input ? 'minimum_payout_minor'
         and jsonb_typeof(p_input -> 'minimum_payout_minor') not in ('number', 'null')) then
    raise exception 'agreement input values are invalid' using errcode = '22023';
  end if;

  begin
    affiliate_id_value := nullif(trim(p_input ->> 'affiliate_id'), '')::uuid;
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement identifiers must be UUIDs' using errcode = '22023';
  end;

  if not exists (
    select 1 from public.affiliates as affiliate
    where affiliate.id = affiliate_id_value
      and affiliate.status in ('active', 'paused')
  ) then raise exception 'partner is not available for an agreement' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.products as product where product.id = product_id_value) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'agreement-version:' || affiliate_id_value::text || ':' || product_id_value::text,
      0
    )
  );
  select coalesce(max(agreement.version), 0) + 1 into next_version
  from public.agreements as agreement
  where agreement.affiliate_id = affiliate_id_value and agreement.product_id = product_id_value;

  insert into public.agreements (
    affiliate_id, product_id, version, model, status, attribution_window_days,
    renewal_duration_days, payout_frequency_days, payout_currency, minimum_payout_minor
  ) values (
    affiliate_id_value,
    product_id_value,
    next_version,
    (p_input ->> 'model')::public.commission_model,
    'draft',
    coalesce((p_input ->> 'attribution_window_days')::integer, 30),
    nullif(p_input ->> 'renewal_duration_days', '')::integer,
    coalesce((p_input ->> 'payout_frequency_days')::integer, 14),
    upper(trim(p_input ->> 'payout_currency')),
    coalesce((p_input ->> 'minimum_payout_minor')::bigint, 10000)
  ) returning * into stored;

  return public.admin_agreement_enriched(stored);
end;
$$;

create or replace function public.activate_admin_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_agreement_id uuid;
  existing public.agreements%rowtype;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'activate agreements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'agreement activation input must contain exactly agreement_id'
      using errcode = '22023';
  end if;
  if not (p_input ? 'agreement_id')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'agreement_id'
     ) then
    raise exception 'agreement activation input must contain exactly agreement_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string' then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end if;
  begin
    p_agreement_id := nullif(trim(p_input ->> 'agreement_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end;
  select * into existing from public.agreements as agreement where agreement.id = p_agreement_id for update;
  if existing.id is null then raise exception 'agreement not found' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'awaiting_signature') then
    raise exception 'only a draft or awaiting-signature agreement can be activated' using errcode = 'P0001';
  end if;
  if (
    select count(*)
    from public.commission_rules as rule
    where rule.agreement_id = existing.id
      and rule.status = 'active'
  ) <> 1 or not exists (
    select 1
    from public.commission_rules as rule
    where rule.agreement_id = existing.id
      and rule.status = 'active'
      and rule.model = existing.model
      and rule.model in ('cpa', 'revenue_share', 'hybrid')
      and rule.trigger_event = 'purchase.completed'
      and (rule.currency is null or rule.currency = existing.payout_currency)
  ) then
    raise exception 'agreement activation requires exactly one supported active purchase rule'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from public.documents as document
    where document.agreement_id = existing.id
      and document.affiliate_id = existing.affiliate_id
      and document.status in ('signed', 'active')
      and document.signed_by_partner_at is not null
      and document.signed_by_partner_at <= now()
      and document.signed_by_kissmyapps_at is not null
      and document.signed_by_kissmyapps_at <= now()
      and (document.effective_at is null or document.effective_at <= now())
      and (document.expires_at is null or document.expires_at > now())
      and document.terminated_at is null
  ) then
    raise exception 'agreement activation requires a current bilaterally signed document'
      using errcode = 'P0001';
  end if;

  update public.agreements as agreement
  set status = 'superseded', ends_at = now()
  where agreement.affiliate_id = existing.affiliate_id
    and agreement.product_id = existing.product_id
    and agreement.id <> existing.id
    and agreement.status = 'active';

  update public.agreements as agreement
  set status = 'active', starts_at = coalesce(agreement.starts_at, now()), ends_at = null
  where agreement.id = existing.id
  returning * into stored;
  return public.admin_agreement_enriched(stored);
end;
$$;

revoke all on function public.create_admin_agreement(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.activate_admin_agreement(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_admin_agreement(jsonb) to authenticated;
grant execute on function public.activate_admin_agreement(jsonb) to authenticated;

comment on function public.admin_agreement_enriched(public.agreements) is
  'Internal shared projection: agreement row plus partner identity, signed-document state, current document, and commission rules. Not executable by browsers.';

begin;

create or replace function public.admin_affiliate_directory_rows(p_affiliate_id uuid default null)
returns table (
  id uuid,
  public_name text,
  legal_name text,
  slug text,
  status public.affiliate_status,
  entity_type public.partner_entity_type,
  country_code text,
  reporting_timezone text,
  preferred_currency text,
  website_url text,
  category text,
  audience_description text,
  audience_countries text[],
  channels text[],
  channel_details text,
  primary_user_id uuid,
  primary_user_role text,
  primary_full_name text,
  primary_email text,
  registration_kind text,
  registered_at timestamptz,
  email_confirmation_status text,
  email_confirmed_at timestamptz,
  activation_status text,
  membership_active boolean,
  activation_pending boolean,
  activated_at timestamptz,
  member_count bigint,
  active_member_count bigint,
  terms_version text,
  terms_url text,
  privacy_version text,
  privacy_url text,
  age_confirmed boolean,
  legal_accepted_at timestamptz,
  product_count bigint,
  agreement_count bigint,
  active_agreement_count bigint,
  blocking_agreement_count bigint,
  blocking_document_count bigint,
  link_count bigint,
  active_link_count bigint,
  unsettled_payout_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with ranked_contacts as (
    select
      membership.affiliate_id,
      membership.user_id,
      membership.role,
      membership.active,
      membership.activation_pending,
      membership.activated_at,
      membership.created_at,
      auth_user.email,
      auth_user.email_confirmed_at,
      auth_user.invited_at,
      profile.full_name,
      row_number() over (
        partition by membership.affiliate_id
        order by
          case
            when membership.role = 'owner'
              and membership.active
              and not membership.activation_pending
              and membership.activated_at is not null then 0
            when membership.role = 'owner'
              and not membership.active
              and membership.activation_pending
              and membership.activated_at is null then 1
            when membership.active
              and not membership.activation_pending then 2
            when membership.activation_pending then 3
            when membership.role = 'owner' then 4
            else 5
          end,
          exists (
            select 1
            from public.platform_legal_acceptances as acceptance
            where acceptance.affiliate_id = membership.affiliate_id
              and acceptance.user_id = membership.user_id
          ) desc,
          membership.created_at,
          membership.user_id
      ) as contact_rank
    from public.affiliate_users as membership
    join auth.users as auth_user on auth_user.id = membership.user_id
    left join public.profiles as profile on profile.user_id = membership.user_id
    where p_affiliate_id is null or membership.affiliate_id = p_affiliate_id
  ),
  primary_contacts as (
    select *
    from ranked_contacts
    where contact_rank = 1
  ),
  latest_acceptances as (
    select distinct on (acceptance.affiliate_id, acceptance.user_id)
      acceptance.id,
      acceptance.affiliate_id,
      acceptance.user_id,
      acceptance.terms_version,
      acceptance.terms_url,
      acceptance.privacy_version,
      acceptance.privacy_url,
      acceptance.age_confirmed,
      acceptance.accepted_at
    from public.platform_legal_acceptances as acceptance
    where p_affiliate_id is null or acceptance.affiliate_id = p_affiliate_id
    order by acceptance.affiliate_id, acceptance.user_id, acceptance.accepted_at desc, acceptance.id
  ),
  member_counts as (
    select
      membership.affiliate_id,
      count(*)::bigint as member_count,
      count(*) filter (where membership.active)::bigint as active_member_count
    from public.affiliate_users as membership
    where p_affiliate_id is null or membership.affiliate_id = p_affiliate_id
    group by membership.affiliate_id
  ),
  affiliate_products as (
    select agreement.affiliate_id, agreement.product_id
    from public.agreements as agreement
    where p_affiliate_id is null or agreement.affiliate_id = p_affiliate_id
    union
    select link.affiliate_id, link.product_id
    from public.affiliate_links as link
    where p_affiliate_id is null or link.affiliate_id = p_affiliate_id
  ),
  product_counts as (
    select product.affiliate_id, count(*)::bigint as product_count
    from affiliate_products as product
    group by product.affiliate_id
  ),
  agreement_counts as (
    select
      agreement.affiliate_id,
      count(*)::bigint as agreement_count,
      count(*) filter (where agreement.status = 'active')::bigint as active_agreement_count,
      count(*) filter (
        where agreement.status in ('awaiting_signature', 'active')
      )::bigint as blocking_agreement_count
    from public.agreements as agreement
    where p_affiliate_id is null or agreement.affiliate_id = p_affiliate_id
    group by agreement.affiliate_id
  ),
  document_counts as (
    select
      document.affiliate_id,
      count(*) filter (
        where document.agreement_id is not null
          and document.status in (
            'awaiting_partner_signature',
            'awaiting_kissmyapps_signature',
            'signed',
            'active'
          )
      )::bigint as blocking_document_count
    from public.documents as document
    where p_affiliate_id is null or document.affiliate_id = p_affiliate_id
    group by document.affiliate_id
  ),
  link_counts as (
    select
      link.affiliate_id,
      count(*)::bigint as link_count,
      count(*) filter (where link.status = 'active')::bigint as active_link_count
    from public.affiliate_links as link
    where p_affiliate_id is null or link.affiliate_id = p_affiliate_id
    group by link.affiliate_id
  ),
  unsettled_payout_obligations as (
    select payout.affiliate_id, count(*)::bigint as obligation_count
    from public.payouts as payout
    where (p_affiliate_id is null or payout.affiliate_id = p_affiliate_id)
      and payout.status not in ('paid', 'carried_forward')
    group by payout.affiliate_id

    union all

    select payout.affiliate_id, count(*)::bigint as obligation_count
    from public.payouts as payout
    where (p_affiliate_id is null or payout.affiliate_id = p_affiliate_id)
      and payout.status = 'carried_forward'
      and payout.carry_out_minor <> 0
      and not exists (
        select 1
        from public.commission_entries as entry
        where entry.entry_type = 'carry_forward'
          and entry.source_payout_id = payout.id
      )
    group by payout.affiliate_id

    union all

    select ledger.affiliate_id, count(*)::bigint as obligation_count
    from (
      select distinct
        entry.affiliate_id,
        entry.product_id,
        entry.payout_period_id
      from public.commission_entries as entry
      where (p_affiliate_id is null or entry.affiliate_id = p_affiliate_id)
        and not exists (
          select 1
          from public.payouts as payout
          where payout.affiliate_id = entry.affiliate_id
            and payout.product_id = entry.product_id
            and payout.payout_period_id = entry.payout_period_id
        )
    ) as ledger
    group by ledger.affiliate_id
  ),
  payout_counts as (
    select
      obligation.affiliate_id,
      sum(obligation.obligation_count)::bigint as unsettled_payout_count
    from unsettled_payout_obligations as obligation
    group by obligation.affiliate_id
  )
  select
    affiliate.id,
    affiliate.public_name,
    affiliate.legal_name,
    affiliate.slug,
    affiliate.status,
    affiliate.entity_type,
    affiliate.country_code,
    affiliate.reporting_timezone,
    affiliate.preferred_currency,
    affiliate.website_url,
    affiliate.category,
    affiliate.audience_description,
    array(
      select btrim(country.value)
      from unnest(affiliate.audience_countries) with ordinality as country(value, ordinal)
      where nullif(btrim(country.value), '') is not null
      order by country.ordinal
    )::text[] as audience_countries,
    array(
      select btrim(channel.value)
      from unnest(affiliate.channels) with ordinality as channel(value, ordinal)
      where nullif(btrim(channel.value), '') is not null
      order by channel.ordinal
    )::text[] as channels,
    affiliate.channel_details,
    contact.user_id as primary_user_id,
    contact.role as primary_user_role,
    contact.full_name as primary_full_name,
    contact.email as primary_email,
    case
      when acceptance.id is not null then 'public'
      when contact.invited_at is not null then 'invited'
      else 'legacy'
    end as registration_kind,
    affiliate.created_at as registered_at,
    case
      when contact.user_id is null or contact.email is null then 'unknown'
      when contact.email_confirmed_at is not null then 'confirmed'
      else 'pending'
    end as email_confirmation_status,
    contact.email_confirmed_at,
    case
      when contact.user_id is null then 'missing'
      when contact.active and not contact.activation_pending and contact.activated_at is not null
        then 'active'
      when not contact.active and contact.activation_pending and contact.activated_at is null
        then 'pending'
      else 'disabled'
    end as activation_status,
    coalesce(contact.active, false) as membership_active,
    coalesce(contact.activation_pending, false) as activation_pending,
    contact.activated_at,
    coalesce(member_count.member_count, 0)::bigint,
    coalesce(member_count.active_member_count, 0)::bigint,
    acceptance.terms_version,
    acceptance.terms_url,
    acceptance.privacy_version,
    acceptance.privacy_url,
    acceptance.age_confirmed,
    acceptance.accepted_at as legal_accepted_at,
    coalesce(product_count.product_count, 0)::bigint,
    coalesce(agreement_count.agreement_count, 0)::bigint,
    coalesce(agreement_count.active_agreement_count, 0)::bigint,
    coalesce(agreement_count.blocking_agreement_count, 0)::bigint,
    coalesce(document_count.blocking_document_count, 0)::bigint,
    coalesce(link_count.link_count, 0)::bigint,
    coalesce(link_count.active_link_count, 0)::bigint,
    coalesce(payout_count.unsettled_payout_count, 0)::bigint,
    affiliate.created_at,
    affiliate.updated_at
  from public.affiliates as affiliate
  left join primary_contacts as contact on contact.affiliate_id = affiliate.id
  left join latest_acceptances as acceptance
    on acceptance.affiliate_id = affiliate.id
   and acceptance.user_id = contact.user_id
  left join member_counts as member_count on member_count.affiliate_id = affiliate.id
  left join product_counts as product_count on product_count.affiliate_id = affiliate.id
  left join agreement_counts as agreement_count on agreement_count.affiliate_id = affiliate.id
  left join document_counts as document_count on document_count.affiliate_id = affiliate.id
  left join link_counts as link_count on link_count.affiliate_id = affiliate.id
  left join payout_counts as payout_count on payout_count.affiliate_id = affiliate.id
  where p_affiliate_id is null or affiliate.id = p_affiliate_id;
$$;

create or replace function public.guard_agreement_activation_affiliate_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  affiliate_state public.affiliate_status;
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select affiliate.status
    into affiliate_state
    from public.affiliates as affiliate
    where affiliate.id = new.affiliate_id
    for share;

    if affiliate_state is distinct from 'active' then
      raise exception 'agreement activation requires an active partner'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists agreements_guard_activation_affiliate_status
  on public.agreements;
create trigger agreements_guard_activation_affiliate_status
  before insert or update of status on public.agreements
  for each row execute function public.guard_agreement_activation_affiliate_status();

create or replace function public.get_admin_affiliate_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations']::text[]) then
    raise exception 'admin role cannot view the partner directory' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_count', count(*),
    'draft_count', count(*) filter (where directory.status = 'draft'),
    'invited_count', count(*) filter (where directory.status = 'invited'),
    'active_count', count(*) filter (where directory.status = 'active'),
    'paused_count', count(*) filter (where directory.status = 'paused'),
    'terminated_count', count(*) filter (where directory.status = 'terminated'),
    'pending_confirmation_count',
      count(*) filter (where directory.email_confirmation_status = 'pending'),
    'pending_activation_count', count(*) filter (where directory.activation_status = 'pending')
  )
  into result
  from public.admin_affiliate_directory_rows(null) as directory;

  return result;
end;
$$;

create or replace function public.get_admin_affiliate_directory(p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'query', 'status', 'confirmation_status', 'activation_status', 'sort', 'limit', 'offset'
  ];
  input_value jsonb := coalesce(p_input, '{}'::jsonb);
  query_value text;
  status_value public.affiliate_status;
  confirmation_value text;
  activation_value text;
  sort_value text := 'newest';
  limit_value integer := 25;
  offset_value integer := 0;
  total_value bigint;
  items_value jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations']::text[]) then
    raise exception 'admin role cannot view the partner directory' using errcode = '42501';
  end if;
  if jsonb_typeof(input_value) is distinct from 'object' then
    raise exception 'partner-directory input contains unsupported fields' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(input_value) as input_key(key)
    where input_key.key <> all(allowed_keys)
  ) then
    raise exception 'partner-directory input contains unsupported fields' using errcode = '22023';
  end if;

  if input_value ? 'query' and jsonb_typeof(input_value -> 'query') not in ('string', 'null') then
    raise exception 'partner-directory query must be a string or null' using errcode = '22023';
  end if;
  query_value := nullif(btrim(input_value ->> 'query'), '');
  if query_value is not null and char_length(query_value) > 120 then
    raise exception 'partner-directory query is too long' using errcode = '22023';
  end if;

  if input_value ? 'status' and jsonb_typeof(input_value -> 'status') not in ('string', 'null') then
    raise exception 'partner-directory status is invalid' using errcode = '22023';
  end if;
  if input_value ->> 'status' is not null then
    if input_value ->> 'status' <> all(array['draft', 'invited', 'active', 'paused', 'terminated']) then
      raise exception 'partner-directory status is invalid' using errcode = '22023';
    end if;
    status_value := (input_value ->> 'status')::public.affiliate_status;
  end if;

  if input_value ? 'confirmation_status'
     and jsonb_typeof(input_value -> 'confirmation_status') not in ('string', 'null') then
    raise exception 'partner-directory confirmation status is invalid' using errcode = '22023';
  end if;
  confirmation_value := input_value ->> 'confirmation_status';
  if confirmation_value is not null
     and confirmation_value <> all(array['confirmed', 'pending', 'unknown']) then
    raise exception 'partner-directory confirmation status is invalid' using errcode = '22023';
  end if;

  if input_value ? 'activation_status'
     and jsonb_typeof(input_value -> 'activation_status') not in ('string', 'null') then
    raise exception 'partner-directory activation status is invalid' using errcode = '22023';
  end if;
  activation_value := input_value ->> 'activation_status';
  if activation_value is not null
     and activation_value <> all(array['active', 'pending', 'disabled', 'missing']) then
    raise exception 'partner-directory activation status is invalid' using errcode = '22023';
  end if;

  if input_value ? 'sort' and jsonb_typeof(input_value -> 'sort') <> 'string' then
    raise exception 'partner-directory sort is invalid' using errcode = '22023';
  end if;
  sort_value := coalesce(input_value ->> 'sort', 'newest');
  if sort_value <> all(array['newest', 'oldest', 'name']) then
    raise exception 'partner-directory sort is invalid' using errcode = '22023';
  end if;

  if input_value ? 'limit' then
    if jsonb_typeof(input_value -> 'limit') <> 'number'
       or (input_value ->> 'limit') !~ '^[0-9]+$' then
      raise exception 'partner-directory limit is invalid' using errcode = '22023';
    end if;
    if (input_value ->> 'limit')::numeric not between 1 and 100 then
      raise exception 'partner-directory limit is invalid' using errcode = '22023';
    end if;
    limit_value := (input_value ->> 'limit')::integer;
  end if;
  if limit_value < 1 or limit_value > 100 then
    raise exception 'partner-directory limit is invalid' using errcode = '22023';
  end if;

  if input_value ? 'offset' then
    if jsonb_typeof(input_value -> 'offset') <> 'number'
       or (input_value ->> 'offset') !~ '^[0-9]+$' then
      raise exception 'partner-directory offset is invalid' using errcode = '22023';
    end if;
    if (input_value ->> 'offset')::numeric not between 0 and 10000 then
      raise exception 'partner-directory offset is invalid' using errcode = '22023';
    end if;
    offset_value := (input_value ->> 'offset')::integer;
  end if;
  if offset_value < 0 or offset_value > 10000 then
    raise exception 'partner-directory offset is invalid' using errcode = '22023';
  end if;

  with filtered as materialized (
    select directory.*
    from public.admin_affiliate_directory_rows(null) as directory
    where (status_value is null or directory.status = status_value)
      and (
        confirmation_value is null
        or directory.email_confirmation_status = confirmation_value
      )
      and (activation_value is null or directory.activation_status = activation_value)
      and (
        query_value is null
        or position(lower(query_value) in lower(directory.public_name)) > 0
        or position(lower(query_value) in lower(directory.slug)) > 0
        or position(lower(query_value) in lower(coalesce(directory.primary_email, ''))) > 0
      )
  ),
  numbered as (
    select
      filtered,
      row_number() over (
        order by
          case when sort_value = 'newest' then filtered.registered_at end desc nulls last,
          case when sort_value = 'oldest' then filtered.registered_at end asc nulls last,
          case when sort_value = 'name' then lower(filtered.public_name) end asc nulls last,
          filtered.id
      ) as ordinal
    from filtered
  ),
  page as (
    select numbered.filtered, numbered.ordinal
    from numbered
    order by numbered.ordinal
    limit limit_value
    offset offset_value
  )
  select
    (select count(*)::bigint from filtered),
    coalesce(
      (select jsonb_agg(to_jsonb(page.filtered) order by page.ordinal) from page),
      '[]'::jsonb
    )
  into total_value, items_value;

  return jsonb_build_object('items', items_value, 'total_count', total_value);
end;
$$;

create or replace function public.get_admin_affiliate_detail(p_affiliate_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations']::text[]) then
    raise exception 'admin role cannot view partner details' using errcode = '42501';
  end if;
  if p_affiliate_id is null then
    raise exception 'partner id is required' using errcode = '22023';
  end if;

  select to_jsonb(directory)
  into result
  from public.admin_affiliate_directory_rows(p_affiliate_id) as directory;

  if result is null then
    raise exception 'partner not found' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

create or replace function public.set_admin_affiliate_status(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['affiliate_id', 'status', 'reason'];
  affiliate_id_value uuid;
  status_value public.affiliate_status;
  reason_value text;
  previous public.affiliates%rowtype;
  changed public.affiliates%rowtype;
begin
  perform public.assert_admin_password(
    array['owner', 'operations']::text[],
    'change partner status'
  );

  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'partner-status input must contain an affiliate id, active or paused status, and reason'
      using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_input)) <> 3
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key)
       where input_key.key <> all(allowed_keys)
     )
     or jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string'
     or jsonb_typeof(p_input -> 'reason') <> 'string'
     or (p_input ->> 'affiliate_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_input ->> 'status' <> all(array['active', 'paused']) then
    raise exception 'partner-status input must contain an affiliate id, active or paused status, and reason'
      using errcode = '22023';
  end if;

  affiliate_id_value := (p_input ->> 'affiliate_id')::uuid;
  status_value := (p_input ->> 'status')::public.affiliate_status;
  reason_value := btrim(p_input ->> 'reason');
  if char_length(reason_value) < 10 or char_length(reason_value) > 500 then
    raise exception 'partner-status reason must contain between 10 and 500 characters'
      using errcode = '22023';
  end if;

  select * into previous
  from public.affiliates as affiliate
  where affiliate.id = affiliate_id_value
  for update;
  if previous.id is null then
    raise exception 'partner not found' using errcode = 'P0002';
  end if;
  if previous.status = status_value then
    return jsonb_build_object(
      'id', previous.id,
      'status', previous.status,
      'updated_at', previous.updated_at
    );
  end if;
  if not (
    (previous.status = 'active' and status_value = 'paused')
    or (previous.status = 'paused' and status_value = 'active')
  ) then
    raise exception 'partner cannot move from % to %', previous.status, status_value
      using errcode = '55000';
  end if;
  if status_value = 'active' and not exists (
    select 1
    from public.affiliate_users as membership
    where membership.affiliate_id = affiliate_id_value
      and membership.role = 'owner'
      and membership.active
      and not membership.activation_pending
      and membership.activated_at is not null
  ) then
    raise exception 'partner reactivation requires an active owner membership'
      using errcode = '55000';
  end if;

  update public.affiliates as affiliate
  set status = status_value
  where affiliate.id = affiliate_id_value
  returning affiliate.* into changed;

  insert into public.audit_logs (
    actor_user_id,
    actor_type,
    action,
    target_table,
    target_id,
    reason,
    before_data,
    after_data,
    metadata
  ) values (
    auth.uid(),
    'admin',
    case when status_value = 'paused' then 'affiliate.pause' else 'affiliate.reactivate' end,
    'affiliates',
    affiliate_id_value,
    reason_value,
    jsonb_build_object('status', previous.status),
    jsonb_build_object('status', changed.status),
    jsonb_build_object('source', 'admin_affiliates_v1')
  );

  return jsonb_build_object(
    'id', changed.id,
    'status', changed.status,
    'updated_at', changed.updated_at
  );
end;
$$;

create or replace function public.terminate_admin_affiliate(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['affiliate_id', 'reason', 'confirmation'];
  affiliate_id_value uuid;
  reason_value text;
  confirmation_value text;
  previous public.affiliates%rowtype;
  changed public.affiliates%rowtype;
  disabled_members integer := 0;
  paused_links integer := 0;
  unsettled_payout_obligations bigint := 0;
begin
  perform public.assert_admin_password(array['owner']::text[], 'terminate partners');

  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'partner-termination input must contain an affiliate id, reason, and confirmation'
      using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_input)) <> 3
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key)
       where input_key.key <> all(allowed_keys)
     )
     or jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'reason') <> 'string'
     or jsonb_typeof(p_input -> 'confirmation') <> 'string'
     or (p_input ->> 'affiliate_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'partner-termination input must contain an affiliate id, reason, and confirmation'
      using errcode = '22023';
  end if;

  affiliate_id_value := (p_input ->> 'affiliate_id')::uuid;
  reason_value := btrim(p_input ->> 'reason');
  confirmation_value := btrim(p_input ->> 'confirmation');
  if char_length(reason_value) < 10 or char_length(reason_value) > 500 then
    raise exception 'partner-termination reason must contain between 10 and 500 characters'
      using errcode = '22023';
  end if;

  select * into previous
  from public.affiliates as affiliate
  where affiliate.id = affiliate_id_value
  for update;
  if previous.id is null then
    raise exception 'partner not found' using errcode = 'P0002';
  end if;
  if previous.status = 'terminated' then
    raise exception 'terminated partners cannot be changed' using errcode = '55000';
  end if;
  if confirmation_value <> previous.slug then
    raise exception 'partner termination confirmation does not match the partner slug'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.agreements as agreement
    where agreement.affiliate_id = affiliate_id_value
      and agreement.status in ('awaiting_signature', 'active')
  ) then
    raise exception 'partner termination requires every active or awaiting-signature agreement to be resolved'
      using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.documents as document
    where document.affiliate_id = affiliate_id_value
      and document.agreement_id is not null
      and document.status in (
        'awaiting_partner_signature',
        'awaiting_kissmyapps_signature',
        'signed',
        'active'
      )
  ) then
    raise exception 'partner termination requires every current agreement document to be resolved'
      using errcode = '55000';
  end if;

  select directory.unsettled_payout_count
  into unsettled_payout_obligations
  from public.admin_affiliate_directory_rows(affiliate_id_value) as directory;
  if coalesce(unsettled_payout_obligations, 0) > 0 then
    raise exception 'partner termination requires every unsettled payout to be resolved'
      using errcode = '55000';
  end if;

  update public.affiliate_links as link
  set
    status = 'paused',
    status_changed_at = now()
  where link.affiliate_id = affiliate_id_value
    and link.status = 'active';
  get diagnostics paused_links = row_count;

  update public.affiliate_users as membership
  set
    active = false,
    activation_pending = false
  where membership.affiliate_id = affiliate_id_value
    and (membership.active or membership.activation_pending);
  get diagnostics disabled_members = row_count;

  update public.affiliates as affiliate
  set status = 'terminated'
  where affiliate.id = affiliate_id_value
  returning affiliate.* into changed;

  insert into public.audit_logs (
    actor_user_id,
    actor_type,
    action,
    target_table,
    target_id,
    reason,
    before_data,
    after_data,
    metadata
  ) values (
    auth.uid(),
    'admin',
    'affiliate.terminate',
    'affiliates',
    affiliate_id_value,
    reason_value,
    jsonb_build_object('status', previous.status),
    jsonb_build_object('status', changed.status),
    jsonb_build_object(
      'source', 'admin_affiliates_v1',
      'memberships_disabled', disabled_members,
      'links_paused', paused_links
    )
  );

  return jsonb_build_object(
    'id', changed.id,
    'status', changed.status,
    'updated_at', changed.updated_at
  );
end;
$$;

do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.admin_affiliate_directory_rows(uuid)',
    'public.guard_agreement_activation_affiliate_status()',
    'public.get_admin_affiliate_summary()',
    'public.get_admin_affiliate_directory(jsonb)',
    'public.get_admin_affiliate_detail(uuid)',
    'public.set_admin_affiliate_status(jsonb)',
    'public.terminate_admin_affiliate(jsonb)'
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
  end loop;
end;
$$;

grant execute on function public.get_admin_affiliate_summary() to authenticated;
grant execute on function public.get_admin_affiliate_directory(jsonb) to authenticated;
grant execute on function public.get_admin_affiliate_detail(uuid) to authenticated;
grant execute on function public.set_admin_affiliate_status(jsonb) to authenticated;
grant execute on function public.terminate_admin_affiliate(jsonb) to authenticated;

comment on function public.admin_affiliate_directory_rows(uuid) is
  'Internal least-privilege row builder for protected Admin affiliate management; never browser executable.';
comment on function public.guard_agreement_activation_affiliate_status() is
  'Serializes agreement activation with affiliate termination and rejects activation unless the partner remains active.';
comment on function public.get_admin_affiliate_summary() is
  'Returns non-financial partner lifecycle counts to Owner and Operations administrators.';
comment on function public.get_admin_affiliate_directory(jsonb) is
  'Returns a filtered, paginated partner directory with primary account and immutable public-registration evidence to Owner and Operations administrators.';
comment on function public.get_admin_affiliate_detail(uuid) is
  'Returns one protected partner lifecycle record to Owner and Operations administrators.';
comment on function public.set_admin_affiliate_status(jsonb) is
  'Pauses or reactivates a partner after password-authenticated Owner or Operations approval with an immutable reason audit.';
comment on function public.terminate_admin_affiliate(jsonb) is
  'Irreversibly terminates partner access after password-authenticated Owner approval, typed slug confirmation, and commercial blocker checks.';

commit;

-- Launch readiness and privacy acceptance using a signed synthetic agreement.
-- Run from the repository root in the disposable native harness.
begin;
\i supabase/tests/fixtures/partner-reporting-launch.sql
do $$
declare
  member_id uuid;
  product_id constant uuid := 'aa280000-0000-4000-8000-000000000001';
  agreement_id constant uuid := 'aa280000-0000-4000-8000-000000000021';
begin
  if exists (select 1 from public.affiliate_users where user_id = '00000000-0000-4000-8000-000000000028') then
    raise exception 'Negative test identity is not unused';
  end if;
  select membership.user_id into strict member_id
  from public.affiliate_users membership
  join public.agreements agreement on agreement.affiliate_id = membership.affiliate_id
  where agreement.id = agreement_id and membership.active
  order by membership.user_id limit 1;
  if not public.agreement_is_launch_ready(agreement_id, statement_timestamp()) then
    raise exception 'Expected synthetic commercial agreement is not ready';
  end if;
  perform set_config('kma_test.member_id', member_id::text, true);
  perform set_config('kma_test.product_id', product_id::text, true);
  perform set_config('kma_test.agreement_id', agreement_id::text, true);
  if has_function_privilege('authenticated', 'public.agreement_is_launch_ready(uuid,timestamptz)', 'execute')
    or has_function_privilege('authenticated', 'public.tracking_only_product_is_ready(uuid)', 'execute') then
    raise exception 'Internal readiness helper exposed';
  end if;
  if has_table_privilege('authenticated','public.agreements','select')
    or has_table_privilege('authenticated','public.funnels','select') then
    raise exception 'Base table read access unexpectedly granted';
  end if;
  if has_function_privilege('anon','public.partner_agreement_is_launch_ready(uuid)','execute')
    or has_function_privilege('anon','public.partner_tracking_only_product_is_ready(uuid)','execute') then
    raise exception 'Anonymous wrapper execution granted';
  end if;
  if (select count(*) from pg_proc where oid in (
      'public.partner_agreement_is_launch_ready(uuid)'::regprocedure,
      'public.partner_tracking_only_product_is_ready(uuid)'::regprocedure)
      and prosecdef and provolatile='s' and proconfig @> array['search_path=""']) <> 2 then
    raise exception 'Wrapper execution settings mismatch';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{}', true);
do $$
begin
  if public.partner_agreement_is_launch_ready(current_setting('kma_test.agreement_id')::uuid)
    or public.partner_tracking_only_product_is_ready(current_setting('kma_test.product_id')::uuid)
    or exists (select 1 from public.partner_product_directory)
    or exists (select 1 from public.partner_link_option_directory) then
    raise exception 'Missing session disclosed partner data';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000028',true),
  set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000028","role":"authenticated"}',true);
do $$
begin
  if public.partner_agreement_is_launch_ready(current_setting('kma_test.agreement_id')::uuid)
    or public.partner_tracking_only_product_is_ready(current_setting('kma_test.product_id')::uuid)
    or public.partner_agreement_is_launch_ready(null)
    or public.partner_tracking_only_product_is_ready(null)
    or exists (select 1 from public.partner_product_directory)
    or exists (select 1 from public.partner_link_option_directory) then
    raise exception 'Non-member or null identifier disclosed partner data';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', current_setting('kma_test.member_id'), true),
  set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.member_id'),'role','authenticated')::text,true);
do $$
declare
  item record;
  product_count integer := 0;
  option_count integer := 0;
begin
  if not public.partner_agreement_is_launch_ready(current_setting('kma_test.agreement_id')::uuid) then
    raise exception 'Current member cannot read own agreement readiness';
  end if;
  if public.partner_agreement_is_launch_ready('00000000-0000-4000-8000-000000000028')
    or public.partner_tracking_only_product_is_ready('00000000-0000-4000-8000-000000000028') then
    raise exception 'Unknown identifier disclosed readiness';
  end if;
  -- Select every column: do not let optimizer pruning hide another private
  -- function permission failure in a projection unused by count(*).
  for item in select * from public.partner_product_directory loop
    product_count := product_count + 1;
    if item.id <> current_setting('kma_test.product_id')::uuid
      or item.status <> 'active' or item.agreement_status <> 'active'
      or item.main_link_id is null or item.main_tracking_url is null
      or item.tracking_mode <> 'commercial' then
      raise exception 'Unexpected product scope or missing issued link';
    end if;
  end loop;
  for item in select * from public.partner_link_option_directory loop
    option_count := option_count + 1;
    if item.product_id is not null and item.product_id <> current_setting('kma_test.product_id')::uuid then
      raise exception 'Cross-product option disclosed';
    end if;
  end loop;
  if product_count <> 1 or option_count < 2 then
    raise exception 'Expected product/funnel/source directory is incomplete';
  end if;
end;
$$;
reset role;
select jsonb_build_object('status','passed','scope','actual authenticated role; synthetic signed launch chain; transaction rolled back') as acceptance;

rollback;

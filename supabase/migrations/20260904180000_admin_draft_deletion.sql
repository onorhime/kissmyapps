-- Draft commercial records may be deleted while no commercial history
-- exists. Once an agreement is active it becomes immutable history; rules
-- on an active agreement can only be superseded, never deleted.

create or replace function public.delete_admin_draft_commission_rule(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['commission_rule_id'];
  rule_id_value uuid;
  rule_record public.commission_rules%rowtype;
  agreement_record public.agreements%rowtype;
  stored public.commission_rules%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'delete draft commission rules');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'commission_rule_id'
     ) then
    raise exception 'delete input must contain exactly commission_rule_id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'commission_rule_id') <> 'string' then
    raise exception 'commission_rule_id must be a UUID' using errcode = '22023';
  end if;

  begin
    rule_id_value := nullif(trim(p_input ->> 'commission_rule_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'commission_rule_id must be a UUID' using errcode = '22023';
  end;

  select * into rule_record
  from public.commission_rules as rule
  where rule.id = rule_id_value
  for update;
  if rule_record.id is null then
    raise exception 'commission rule not found' using errcode = 'P0002';
  end if;

  select * into agreement_record
  from public.agreements as agreement
  where agreement.id = rule_record.agreement_id
  for update;
  if agreement_record.status = 'active' then
    raise exception 'rules on an active agreement are immutable history; supersede instead'
      using errcode = 'P0001';
  end if;
  if agreement_record.status in ('superseded', 'expired', 'terminated') then
    raise exception 'rules on a closed agreement are immutable history' using errcode = 'P0001';
  end if;

  delete from public.commission_rules as rule
  where rule.id = rule_record.id
  returning * into stored;

  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id
  ) values (
    auth.uid(), 'admin', 'commission_rule.delete', 'commission_rules', stored.id
  );

  return to_jsonb(stored);
end;
$$;

create or replace function public.delete_admin_draft_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['agreement_id'];
  agreement_id_value uuid;
  agreement_record public.agreements%rowtype;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'delete draft agreements');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'agreement_id'
     ) then
    raise exception 'delete input must contain exactly agreement_id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string' then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end if;

  begin
    agreement_id_value := nullif(trim(p_input ->> 'agreement_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end;

  select * into agreement_record
  from public.agreements as agreement
  where agreement.id = agreement_id_value
  for update;
  if agreement_record.id is null then
    raise exception 'agreement not found' using errcode = 'P0002';
  end if;
  if agreement_record.status not in ('draft', 'awaiting_signature') then
    raise exception 'only a draft or awaiting-signature agreement can be deleted; active terms are immutable history'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.documents as document
    where document.agreement_id = agreement_record.id
      and document.status not in ('draft', 'superseded', 'expired', 'terminated')
  ) then
    raise exception 'revoke the agreement document before deleting this agreement'
      using errcode = 'P0001';
  end if;

  delete from public.commission_rules as rule
  where rule.agreement_id = agreement_record.id;

  delete from public.agreements as agreement
  where agreement.id = agreement_record.id
  returning * into stored;

  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id
  ) values (
    auth.uid(), 'admin', 'agreement.delete', 'agreements', stored.id
  );

  return to_jsonb(stored);
end;
$$;

revoke all on function public.delete_admin_draft_commission_rule(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_admin_draft_agreement(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_admin_draft_commission_rule(jsonb) to authenticated;
grant execute on function public.delete_admin_draft_agreement(jsonb) to authenticated;

comment on function public.delete_admin_draft_commission_rule(jsonb) is
  'Owner/Operations password-authenticated deletion of a commission rule whose agreement is not active. Active-agreement rules are immutable and can only be superseded.';
comment on function public.delete_admin_draft_agreement(jsonb) is
  'Owner/Operations password-authenticated deletion of a draft or awaiting-signature agreement with no live document; its draft rules are removed with it.';

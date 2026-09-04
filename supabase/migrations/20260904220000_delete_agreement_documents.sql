-- Deleting a draft agreement must remove its unsigned document rows as
-- well: a revoked or awaiting document row would otherwise keep referencing
-- the agreement (documents_agreement_id_fkey has no cascade) and block the
-- deletion with a foreign-key conflict. Only never-fully-signed documents
-- are removed; fully signed documents already block deletion as preserved
-- evidence. Audit history of every removed row is retained in audit_logs.

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
      and document.affiliate_id = agreement_record.affiliate_id
      and document.status in ('signed', 'active')
  ) then
    raise exception 'this agreement already has a fully signed document, which is kept as evidence and cannot be deleted'
      using errcode = 'P0001';
  end if;

  delete from public.documents as document
  where document.agreement_id = agreement_record.id
    and document.affiliate_id = agreement_record.affiliate_id;

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

  return public.admin_agreement_enriched(stored);
end;
$$;

revoke all on function public.delete_admin_draft_agreement(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_admin_draft_agreement(jsonb) to authenticated;

comment on function public.delete_admin_draft_agreement(jsonb) is
  'Owner/Operations password-authenticated deletion of a draft or awaiting-signature agreement. Unsigned document rows and draft rules are removed with it; a fully signed document blocks deletion as preserved evidence. Returns the shared enriched agreement projection.';

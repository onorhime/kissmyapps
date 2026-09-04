-- Bilateral agreement signing: admins attach the versioned terms PDF to a
-- draft agreement, the password-authenticated partner signs it, and an
-- Owner/Operations administrator countersigns. Signature evidence is
-- immutable; superseded documents are replaced by a new version, never edited.

alter table public.documents
  add column if not exists partner_signer_user_id uuid references auth.users (id),
  add column if not exists partner_signer_name text
    check (partner_signer_name is null or char_length(partner_signer_name) between 2 and 160),
  add column if not exists kissmyapps_signer_user_id uuid references auth.users (id);

-- Admins may upload the agreement terms into the private bucket. Object-level
-- authorization stays path-scoped: the recording RPC below binds the stored
-- object to the agreement's exact affiliate prefix.
drop policy if exists affiliate_private_documents_admin_write on storage.objects;
create policy affiliate_private_documents_admin_write
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'affiliate-private-documents'
    and public.current_user_is_admin(array['owner', 'operations']::text[])
  );

create or replace function public.create_admin_agreement_document(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['agreement_id', 'name', 'file_path'];
  agreement_id_value uuid;
  name_value text;
  file_path_value text;
  agreement_record public.agreements%rowtype;
  storage_object storage.objects%rowtype;
  next_version integer;
  stored public.documents%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'record agreement documents');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'agreement document input must contain exactly agreement_id, name, and file_path'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'file_path') <> 'string' then
    raise exception 'agreement document input values are invalid' using errcode = '22023';
  end if;

  agreement_id_value := nullif(trim(p_input ->> 'agreement_id'), '')::uuid;
  name_value := nullif(trim(p_input ->> 'name'), '');
  file_path_value := nullif(trim(p_input ->> 'file_path'), '');
  if agreement_id_value is null or name_value is null or file_path_value is null then
    raise exception 'agreement document input values are invalid' using errcode = '22023';
  end if;
  if char_length(name_value) > 160 then
    raise exception 'the agreement document name is too long' using errcode = '22023';
  end if;

  select * into agreement_record
  from public.agreements as agreement
  where agreement.id = agreement_id_value
  for update;
  if agreement_record.id is null then
    raise exception 'agreement not found' using errcode = 'P0002';
  end if;
  if agreement_record.status in ('superseded', 'expired', 'terminated') then
    raise exception 'a closed agreement cannot receive a new document' using errcode = 'P0001';
  end if;

  if substr(file_path_value, 1, char_length(agreement_record.affiliate_id::text) + 1)
       <> (agreement_record.affiliate_id::text || '/')
     or position('..' in file_path_value) > 0 then
    raise exception 'the agreement document must be stored under the partner private prefix'
      using errcode = '22023';
  end if;

  select * into storage_object
  from storage.objects as object
  where object.bucket_id = 'affiliate-private-documents'
    and object.name = file_path_value;
  if storage_object.name is null then
    raise exception 'the uploaded agreement document could not be found' using errcode = 'P0001';
  end if;
  if coalesce(storage_object.metadata ->> 'mimetype', '') <> 'application/pdf'
     or coalesce((storage_object.metadata ->> 'size')::bigint, 0) not between 1 and 10485760 then
    raise exception 'the agreement document must be a PDF of at most 10 MB' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.documents as document
    where document.agreement_id = agreement_record.id
      and document.affiliate_id = agreement_record.affiliate_id
      and document.status not in ('superseded', 'expired', 'terminated')
  ) then
    raise exception 'this agreement already has a current document; revoke it first'
      using errcode = 'P0001';
  end if;

  select coalesce(max(document.version), 0) + 1 into next_version
  from public.documents as document
  where document.affiliate_id = agreement_record.affiliate_id
    and document.document_type = 'partner_agreement';

  insert into public.documents (
    affiliate_id, agreement_id, name, document_type, version, file_path,
    status
  ) values (
    agreement_record.affiliate_id, agreement_record.id, name_value,
    'partner_agreement', next_version, file_path_value,
    'awaiting_partner_signature'
  )
  returning * into stored;

  return to_jsonb(stored);
end;
$$;

create or replace function public.partner_sign_agreement_document(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['document_id', 'legal_name'];
  document_id_value uuid;
  legal_name_value text;
  partner_id uuid;
  document_record public.documents%rowtype;
  agreement_record public.agreements%rowtype;
  stored public.documents%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  partner_id := public.current_partner_affiliate_id(true);

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'partner signature input must contain exactly document_id and legal_name'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'document_id') <> 'string'
     or jsonb_typeof(p_input -> 'legal_name') <> 'string' then
    raise exception 'partner signature input values are invalid' using errcode = '22023';
  end if;

  document_id_value := nullif(trim(p_input ->> 'document_id'), '')::uuid;
  legal_name_value := nullif(trim(p_input ->> 'legal_name'), '');
  if document_id_value is null
     or legal_name_value is null
     or char_length(legal_name_value) not between 2 and 160 then
    raise exception 'partner signature input values are invalid' using errcode = '22023';
  end if;

  select * into document_record
  from public.documents as document
  where document.id = document_id_value
  for update;
  if document_record.id is null then
    raise exception 'agreement document not found' using errcode = 'P0002';
  end if;
  if document_record.affiliate_id <> partner_id then
    raise exception 'this agreement does not belong to the signed-in partner' using errcode = '42501';
  end if;
  if document_record.status <> 'awaiting_partner_signature' then
    raise exception 'this agreement document is not awaiting the partner signature'
      using errcode = 'P0001';
  end if;

  select * into agreement_record
  from public.agreements as agreement
  where agreement.id = document_record.agreement_id;
  if agreement_record.id is null
     or agreement_record.status in ('superseded', 'expired', 'terminated') then
    raise exception 'the agreement behind this document is no longer current' using errcode = 'P0001';
  end if;

  update public.documents as document
  set status = 'awaiting_kissmyapps_signature',
      partner_signer_user_id = auth.uid(),
      partner_signer_name = legal_name_value,
      signed_by_partner_at = now(),
      updated_at = now()
  where document.id = document_record.id
  returning * into stored;

  return to_jsonb(stored);
end;
$$;

create or replace function public.admin_countersign_agreement_document(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['document_id'];
  document_id_value uuid;
  document_record public.documents%rowtype;
  stored public.documents%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'countersign agreement documents');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'document_id'
     ) then
    raise exception 'countersign input must contain exactly document_id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'document_id') <> 'string' then
    raise exception 'document_id must be a UUID' using errcode = '22023';
  end if;

  begin
    document_id_value := nullif(trim(p_input ->> 'document_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'document_id must be a UUID' using errcode = '22023';
  end;

  select * into document_record
  from public.documents as document
  where document.id = document_id_value
  for update;
  if document_record.id is null then
    raise exception 'agreement document not found' using errcode = 'P0002';
  end if;
  if document_record.status <> 'awaiting_kissmyapps_signature' then
    raise exception 'this agreement document is not awaiting the KissMyApps signature'
      using errcode = 'P0001';
  end if;

  update public.documents as document
  set status = 'signed',
      kissmyapps_signer_user_id = auth.uid(),
      signed_by_kissmyapps_at = now(),
      effective_at = coalesce(document.effective_at, now()),
      updated_at = now()
  where document.id = document_record.id
  returning * into stored;

  return to_jsonb(stored);
end;
$$;

create or replace function public.revoke_admin_agreement_document(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['document_id', 'reason'];
  document_id_value uuid;
  reason_value text;
  document_record public.documents%rowtype;
  stored public.documents%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'revoke agreement documents');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'revoke input must contain exactly document_id and reason' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'document_id') <> 'string'
     or jsonb_typeof(p_input -> 'reason') <> 'string' then
    raise exception 'revoke input values are invalid' using errcode = '22023';
  end if;

  begin
    document_id_value := nullif(trim(p_input ->> 'document_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'document_id must be a UUID' using errcode = '22023';
  end;
  reason_value := nullif(trim(p_input ->> 'reason'), '');
  if document_id_value is null or reason_value is null
     or char_length(reason_value) not between 10 and 500 then
    raise exception 'a revocation reason between 10 and 500 characters is required'
      using errcode = '22023';
  end if;

  select * into document_record
  from public.documents as document
  where document.id = document_id_value
  for update;
  if document_record.id is null then
    raise exception 'agreement document not found' using errcode = 'P0002';
  end if;
  if document_record.status not in ('awaiting_partner_signature', 'awaiting_kissmyapps_signature') then
    raise exception 'only a document that has not been fully signed can be revoked'
      using errcode = 'P0001';
  end if;

  update public.documents as document
  set status = 'terminated',
      terminated_at = now(),
      updated_at = now()
  where document.id = document_record.id
  returning * into stored;

  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id, reason
  ) values (
    auth.uid(), 'admin', 'agreement_document.revoke', 'documents', stored.id, reason_value
  );

  return to_jsonb(stored);
end;
$$;

create or replace function public.get_partner_agreement_signature_queue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'document_id', document.id,
        'name', document.name,
        'version', document.version,
        'agreement_id', agreement.id,
        'product_id', agreement.product_id,
        'product_name', product.name,
        'model', agreement.model,
        'attribution_window_days', agreement.attribution_window_days,
        'payout_frequency_days', agreement.payout_frequency_days,
        'payout_currency', agreement.payout_currency,
        'minimum_payout_minor', agreement.minimum_payout_minor,
        'file_path', document.file_path,
        'requested_at', document.created_at
      ) order by document.created_at, document.id
    ),
    '[]'::jsonb
  )
  from public.documents as document
  join public.agreements as agreement on agreement.id = document.agreement_id
  join public.products as product on product.id = agreement.product_id
  where document.affiliate_id = public.current_partner_affiliate_id(true)
    and document.status = 'awaiting_partner_signature'
    and agreement.status not in ('superseded', 'expired', 'terminated')
$$;

revoke all on function public.create_admin_agreement_document(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_countersign_agreement_document(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.revoke_admin_agreement_document(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.partner_sign_agreement_document(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_partner_agreement_signature_queue()
  from public, anon, authenticated, service_role;

grant execute on function public.create_admin_agreement_document(jsonb) to authenticated;
grant execute on function public.admin_countersign_agreement_document(jsonb) to authenticated;
grant execute on function public.revoke_admin_agreement_document(jsonb) to authenticated;
grant execute on function public.partner_sign_agreement_document(jsonb) to authenticated;
grant execute on function public.get_partner_agreement_signature_queue() to authenticated;

comment on function public.create_admin_agreement_document(jsonb) is
  'Owner/Operations password-authenticated recording of an uploaded agreement terms PDF. Binds an existing private-bucket object to the agreement and moves it to awaiting_partner_signature.';
comment on function public.partner_sign_agreement_document(jsonb) is
  'Password-authenticated active partner signs the exact awaiting document with their typed legal name; evidence is immutable.';
comment on function public.admin_countersign_agreement_document(jsonb) is
  'Owner/Operations password-authenticated countersignature that completes the bilateral document and marks it signed.';
comment on function public.revoke_admin_agreement_document(jsonb) is
  'Owner/Operations revocation of a not-yet-fully-signed document with an audited reason; signed documents are immutable.';
comment on function public.get_partner_agreement_signature_queue() is
  'Partner-visible queue of agreement documents awaiting the partner signature.';
comment on column public.documents.partner_signer_name is
  'The legal name typed by the partner signer at signature time; signing evidence, never editable.';

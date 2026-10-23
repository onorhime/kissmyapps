begin;

-- Existing signatures cannot be retroactively represented as evidence of the
-- newly bound revision. Stop for an explicit legacy-document migration plan.
do $$ begin
  if exists(select 1 from public.documents where document_type='partner_agreement') then
    raise exception 'agreement evidence migration requires review of existing agreement documents';
  end if;
end; $$;

alter table public.documents
  add column terms_snapshot jsonb,
  add column terms_sha256 text check (terms_sha256 ~ '^[a-f0-9]{64}$'),
  add column content_sha256 text check (content_sha256 ~ '^[a-f0-9]{64}$'),
  add column storage_object_id uuid,
  add column storage_version text,
  add column storage_etag text,
  add column partner_acknowledged_at timestamptz;

-- A stable commercial revision, independent of activation/lifecycle timestamps.
create or replace function public.agreement_terms_snapshot(p_agreement_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'agreement_id', a.id, 'affiliate_id', a.affiliate_id, 'product_id', a.product_id,
    'version', a.version, 'model', a.model,
    'attribution_window_days', a.attribution_window_days,
    'renewal_duration_days', a.renewal_duration_days,
    'payout_frequency_days', a.payout_frequency_days, 'payout_currency', a.payout_currency,
    'minimum_payout_minor', a.minimum_payout_minor,
    'rules', coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'version', r.version, 'name', r.name, 'model', r.model,
      'trigger_event', r.trigger_event, 'fixed_amount_minor', r.fixed_amount_minor,
      'rate_basis_points', r.rate_basis_points, 'currency', r.currency,
      'validation_window_hours', r.validation_window_hours
    ) order by r.id) from public.commission_rules r
      where r.agreement_id = a.id and r.status = 'active'), '[]'::jsonb)
  ) from public.agreements a where a.id = p_agreement_id;
$$;

create or replace function public.guard_agreement_signing_terms()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  if tg_table_name = 'commission_rules' then
    target_id := case when tg_op = 'DELETE' then old.agreement_id else new.agreement_id end;
    perform 1 from public.agreements where id = target_id for update;
  else
    target_id := old.id;
    -- Activation/closure does not change the commercial terms.
    if tg_op = 'UPDATE' and
      (to_jsonb(new) - array['status','starts_at','ends_at','updated_at']) =
      (to_jsonb(old) - array['status','starts_at','ends_at','updated_at']) then
      return new;
    end if;
  end if;
  if exists (select 1 from public.documents d where d.agreement_id = target_id
    and (d.status in ('awaiting_partner_signature','awaiting_kissmyapps_signature','signed','active')
      or d.signed_by_kissmyapps_at is not null)) then
    raise exception 'commercial terms are frozen for signing; revoke the pending document or create a new agreement version'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger agreements_signing_terms_guard before update or delete on public.agreements
  for each row execute function public.guard_agreement_signing_terms();
create trigger commission_rules_signing_terms_guard before insert or update or delete on public.commission_rules
  for each row execute function public.guard_agreement_signing_terms();

create or replace function public.assert_partner_signer()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare partner_id uuid;
begin
  partner_id := public.current_partner_affiliate_id(true);
  if not public.current_user_has_affiliate_role(partner_id, array['owner']::text[], true)
    or not exists (select 1 from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr' else '[]'::jsonb end
    ) m where m->>'method' = 'password') then
    raise exception 'signing requires a password-authenticated partner Owner' using errcode = '42501';
  end if;
  return partner_id;
end;
$$;

create or replace function public.guard_agreement_document_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.agreements%rowtype; obj storage.objects%rowtype; snapshot jsonb;
begin
  if tg_op = 'DELETE' then
    if old.signed_by_kissmyapps_at is not null or old.status in ('signed','active') then
      raise exception 'fully signed document evidence is immutable' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if new.document_type <> 'partner_agreement' then return new; end if;
  select * into a from public.agreements where id = new.agreement_id for update;
  if a.id is null or a.affiliate_id <> new.affiliate_id then
    raise exception 'agreement document scope is invalid' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    if old.signed_by_kissmyapps_at is not null or old.status in ('signed','active') then
      raise exception 'fully signed document evidence is immutable' using errcode = 'P0001';
    end if;
    if (to_jsonb(new) - array['status','terminated_at','updated_at','partner_signer_user_id',
      'partner_signer_name','signed_by_partner_at','partner_acknowledged_at',
      'kissmyapps_signer_user_id','signed_by_kissmyapps_at','effective_at'])
      is distinct from
      (to_jsonb(old) - array['status','terminated_at','updated_at','partner_signer_user_id',
      'partner_signer_name','signed_by_partner_at','partner_acknowledged_at',
      'kissmyapps_signer_user_id','signed_by_kissmyapps_at','effective_at']) then
      raise exception 'document identity and signed terms are immutable' using errcode = 'P0001';
    end if;
    if old.signed_by_partner_at is not null and
      row(new.partner_signer_user_id,new.partner_signer_name,new.signed_by_partner_at,new.partner_acknowledged_at)
      is distinct from row(old.partner_signer_user_id,old.partner_signer_name,old.signed_by_partner_at,old.partner_acknowledged_at) then
      raise exception 'partner signature evidence is immutable' using errcode = 'P0001';
    end if;
    if new.status = 'terminated' then return new; end if;
  end if;
  if a.status not in ('draft','awaiting_signature') then
    raise exception 'signing requires a draft agreement revision' using errcode = 'P0001';
  end if;
  snapshot := public.agreement_terms_snapshot(a.id);
  if jsonb_array_length(snapshot->'rules') <> 1 or
     snapshot #>> '{rules,0,trigger_event}' <> 'purchase.completed' then
    raise exception 'activate exactly one purchase commission rule before requesting signatures' using errcode = 'P0001';
  end if;
  select * into obj from storage.objects
    where bucket_id = 'affiliate-private-documents' and name = new.file_path for share;
  if obj.id is null or new.content_sha256 is null then
    raise exception 'the uploaded PDF and its content digest are required' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'awaiting_partner_signature' then
      raise exception 'agreement documents must begin awaiting partner signature' using errcode = 'P0001';
    end if;
    new.terms_snapshot := snapshot;
    new.terms_sha256 := encode(extensions.digest(snapshot::text,'sha256'),'hex');
    new.storage_object_id := obj.id;
    new.storage_version := obj.version;
    new.storage_etag := obj.metadata->>'eTag';
  elsif new.terms_snapshot is distinct from snapshot
    or new.terms_sha256 is distinct from encode(extensions.digest(snapshot::text,'sha256'),'hex')
    or new.storage_object_id is distinct from obj.id
    or new.storage_version is distinct from obj.version
    or new.storage_etag is distinct from obj.metadata->>'eTag' then
    raise exception 'the document or commercial terms changed; request a new signature' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger documents_evidence_guard before insert or update or delete on public.documents
  for each row execute function public.guard_agreement_document_evidence();

revoke all on function public.agreement_terms_snapshot(uuid), public.guard_agreement_signing_terms(),
  public.assert_partner_signer(), public.guard_agreement_document_evidence()
  from public, anon, authenticated, service_role;

comment on column public.documents.content_sha256 is
  'SHA-256 calculated over the uploaded PDF by the authenticated uploading admin; not a server attestation. Storage object id/version/etag are independently pinned by the database.';
comment on column public.documents.terms_snapshot is
  'Immutable agreement and active-rule revision captured at signature request time.';

create or replace function public.create_admin_agreement_document(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['agreement_id', 'name', 'file_path', 'content_sha256'];
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
    raise exception 'agreement document input must contain exactly agreement_id, name, file_path, and content_sha256'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'file_path') <> 'string'
     or coalesce(p_input->>'content_sha256','') !~ '^[a-f0-9]{64}$' then
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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'agreement-document-version:' || agreement_record.affiliate_id::text, 0));
  select coalesce(max(document.version), 0) + 1 into next_version
  from public.documents as document
  where document.affiliate_id = agreement_record.affiliate_id
    and document.document_type = 'partner_agreement';

  insert into public.documents (
    affiliate_id, agreement_id, name, document_type, version, file_path,
    status, content_sha256
  ) values (
    agreement_record.affiliate_id, agreement_record.id, name_value,
    'partner_agreement', next_version, file_path_value,
    'awaiting_partner_signature', p_input->>'content_sha256'
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
  allowed_keys constant text[] := array['document_id', 'legal_name', 'acknowledged'];
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
  partner_id := public.assert_partner_signer();

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'partner signature input must contain exactly document_id, legal_name, and acknowledged'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'document_id') <> 'string'
     or jsonb_typeof(p_input -> 'legal_name') <> 'string'
     or p_input->'acknowledged' is distinct from 'true'::jsonb then
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
      partner_acknowledged_at = now(),
      updated_at = now()
  where document.id = document_record.id
  returning * into stored;

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
    and public.current_user_has_affiliate_role(document.affiliate_id, array['owner']::text[], true)
    and document.status = 'awaiting_partner_signature'
    and agreement.status not in ('superseded', 'expired', 'terminated')
$$;

commit;

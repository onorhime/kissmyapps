begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_column(
  'public', 'documents', 'partner_signer_user_id',
  'documents record the partner signer user'
);
select has_column(
  'public', 'documents', 'partner_signer_name',
  'documents record the typed partner legal name'
);
select has_column(
  'public', 'documents', 'kissmyapps_signer_user_id',
  'documents record the KissMyApps countersigner'
);

select has_function(
  'public', 'create_admin_agreement_document', array['jsonb'],
  'admin agreement document recording RPC exists'
);
select has_function(
  'public', 'partner_sign_agreement_document', array['jsonb'],
  'partner signing RPC exists'
);
select has_function(
  'public', 'admin_countersign_agreement_document', array['jsonb'],
  'admin countersign RPC exists'
);
select has_function(
  'public', 'revoke_admin_agreement_document', array['jsonb'],
  'admin document revocation RPC exists'
);
select has_function(
  'public', 'get_partner_agreement_signature_queue', array[]::text[],
  'partner signature queue RPC exists'
);

select ok(
  has_function_privilege('authenticated', 'public.create_admin_agreement_document(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.partner_sign_agreement_document(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.admin_countersign_agreement_document(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.revoke_admin_agreement_document(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_partner_agreement_signature_queue()', 'EXECUTE'),
  'authenticated browsers receive exactly the signing entrypoints'
);

select ok(
  not has_function_privilege('anon', 'public.create_admin_agreement_document(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.partner_sign_agreement_document(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_partner_agreement_signature_queue()', 'EXECUTE'),
  'anonymous callers cannot reach signing entrypoints'
);

select ok(
  has_table_privilege('authenticated', 'storage.objects', 'INSERT'),
  'authenticated uploads have the insert grant required by the storage policy'
);
-- pgTAP installations differ in policy helpers; inspect the PostgreSQL catalog directly.
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'affiliate_private_documents_admin_write'
  ),
  'admin document upload policy exists'
);
select is(
  (
    select count(*)::integer
    from pg_policies as policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname = 'affiliate_private_documents_admin_write'
      and policy.cmd = 'INSERT'
  ),
  1,
  'exactly one admin storage upload policy exists'
);

select is(
  (
    select count(*)::integer
    from pg_constraint as constraint_record
    where constraint_record.conrelid = 'public.documents'::regclass
      and constraint_record.conname like '%documents%'
      and constraint_record.contype = 'c'
      and pg_get_constraintdef(constraint_record.oid) like '%partner_signer_name%'
  ),
  1,
  'partner signer name carries a length constraint'
);

select * from finish();
rollback;

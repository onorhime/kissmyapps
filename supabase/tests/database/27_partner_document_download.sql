-- Run only after the document-download migration. No fixture writes or external
-- Storage requests; the local JWT settings below are rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function('public', 'get_partner_document_download', array['uuid']);
select ok(has_function_privilege('authenticated', 'public.get_partner_document_download(uuid)', 'execute'),
  'authenticated partners can request an authorized document locator');
select ok(not has_function_privilege('anon', 'public.get_partner_document_download(uuid)', 'execute'),
  'anonymous clients cannot request document locators');
select is((select provolatile::text from pg_proc where oid = 'public.get_partner_document_download(uuid)'::regprocedure),
  's', 'the resolver is stable and does not mutate documents');

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select throws_ok($$select public.get_partner_document_download('00000000-0000-4000-8000-000000000027')$$,
  '42501', 'Sign in to access partner documents', 'an absent session is denied');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000027","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000027', true);
select throws_ok($$select public.get_partner_document_download('00000000-0000-4000-8000-000000000027')$$,
  '42501', 'This document is not available to your account', 'an unknown document is denied without leaking its existence');
select throws_ok($$select public.get_partner_document_download(null)$$,
  '42501', 'This document is not available to your account', 'a null document ID is denied');

-- Read-only policy checks against any real partner document already in the DB.
-- Skip live-record assertions in an empty test database instead of fabricating
-- a legal signature or private Storage object.
select throws_ok(format('select public.get_partner_document_download(%L::uuid)', document.id),
  '42501', 'This document is not available to your account', 'a non-member cannot resolve a different partner document')
from public.documents as document
where not public.current_user_has_affiliate(document.affiliate_id)
order by document.id limit 1;

select * from finish();
rollback;

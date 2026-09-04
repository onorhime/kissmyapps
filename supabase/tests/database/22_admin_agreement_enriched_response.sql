begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'admin_agreement_enriched', array['public.agreements'],
  'agreement enrichment projection exists'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_agreement_enriched(public.agreements)', 'EXECUTE'),
  'the enrichment projection is not executable by browsers'
);
select ok(
  has_function_privilege('authenticated', 'public.create_admin_agreement(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.activate_admin_agreement(jsonb)', 'EXECUTE'),
  'agreement mutations remain available to authenticated admins'
);

commit;

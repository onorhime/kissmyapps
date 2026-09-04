begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'delete_admin_draft_commission_rule', array['jsonb'],
  'draft commission rule deletion RPC exists'
);
select has_function(
  'public', 'delete_admin_draft_agreement', array['jsonb'],
  'draft agreement deletion RPC exists'
);

select ok(
  has_function_privilege('authenticated', 'public.delete_admin_draft_commission_rule(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delete_admin_draft_agreement(jsonb)', 'EXECUTE'),
  'authenticated admins can delete draft commercial records'
);

select ok(
  not has_function_privilege('anon', 'public.delete_admin_draft_commission_rule(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_admin_draft_agreement(jsonb)', 'EXECUTE'),
  'anonymous callers cannot reach the deletion entrypoints'
);

commit;

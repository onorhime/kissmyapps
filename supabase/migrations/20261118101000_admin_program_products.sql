-- Affiliate self-serve, Phase 5: which products belong to a program.
--
-- A program makes its own product and default funnel when its first listing is approved.
-- The admin app marks those products, sends their setup to Programs and keeps the old setup
-- wizard for every other product (a custom deal). get_admin_products() is left as it is:
-- older suites compare its rows column by column.
begin;

-- One entry per program that has a product, for the roles that can read Products.
create function public.get_admin_program_products() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view products' using errcode = '42501';
  end if;
  return jsonb_build_object('products', coalesce((
    select jsonb_agg(jsonb_build_object(
        'product_id', p.product_id, 'program_id', p.id, 'program_name', p.name, 'program_slug', p.slug,
        'program_status', p.status)
      order by p.name, p.id)
    from public.affiliate_programs p where p.product_id is not null), '[]'::jsonb));
end $$;

revoke all on function public.get_admin_program_products() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_program_products() to authenticated;

commit;

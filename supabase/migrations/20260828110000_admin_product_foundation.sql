create or replace function public.get_admin_context()
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;

  if not public.current_user_is_admin() then
    raise exception 'active admin access is required' using errcode = '42501';
  end if;

  return query
  select
    admin_user.user_id,
    auth.jwt() ->> 'email',
    profile.full_name,
    admin_user.role,
    admin_user.active
  from public.admin_users as admin_user
  left join public.profiles as profile on profile.user_id = admin_user.user_id
  where admin_user.user_id = caller_id
    and admin_user.active;
end;
$$;

create or replace function public.get_admin_products()
returns table (
  id uuid,
  slug text,
  name text,
  status public.product_status,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;

  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view products' using errcode = '42501';
  end if;

  return query
  select
    product.id,
    product.slug,
    product.name,
    product.status,
    product.created_at,
    product.updated_at
  from public.products as product
  order by product.name, product.id;
end;
$$;

create or replace function public.create_admin_product(p_input jsonb)
returns table (
  id uuid,
  slug text,
  name text,
  status public.product_status,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['name', 'slug'];
  name_value text;
  slug_value text;
  inserted_product public.products%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;

  if not public.current_user_is_admin(array['owner', 'operations']::text[]) then
    raise exception 'admin role cannot create products' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
        else '[]'::jsonb
      end
    ) as authentication_method(entry)
    where authentication_method.entry ->> 'method' = 'password'
  ) then
    raise exception 'product creation requires a password-authenticated session'
      using errcode = '42501';
  end if;

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'product input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) then
    raise exception 'product input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ? 'name') or not (p_input ? 'slug') then
    raise exception 'product name and slug are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'slug') <> 'string' then
    raise exception 'product name and slug must be strings' using errcode = '22023';
  end if;

  name_value := trim(p_input ->> 'name');
  slug_value := trim(p_input ->> 'slug');

  if char_length(name_value) not between 1 and 120 then
    raise exception 'product name must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;
  if char_length(slug_value) not between 1 and 120
     or slug_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'product slug must use 1 to 120 lowercase letters, numbers, or single hyphens'
      using errcode = '22023';
  end if;

  insert into public.products (name, slug, status)
  values (name_value, slug_value, 'draft')
  returning * into inserted_product;

  return query
  select
    inserted_product.id,
    inserted_product.slug,
    inserted_product.name,
    inserted_product.status,
    inserted_product.created_at,
    inserted_product.updated_at;
end;
$$;

drop trigger if exists products_audit_mutation on public.products;
create trigger products_audit_mutation
  after insert or update or delete on public.products
  for each row execute function public.audit_mutation();

revoke all on function public.get_admin_context() from public, anon, authenticated;
revoke all on function public.get_admin_products() from public, anon, authenticated;
revoke all on function public.create_admin_product(jsonb) from public, anon, authenticated;

grant execute on function public.get_admin_context() to authenticated;
grant execute on function public.get_admin_products() to authenticated;
grant execute on function public.create_admin_product(jsonb) to authenticated;

comment on function public.get_admin_context() is
  'Returns the authenticated active administrator identity and role.';
comment on function public.get_admin_products() is
  'Returns the product catalogue only to administrator roles already allowed to read products.';
comment on function public.create_admin_product(jsonb) is
  'Creates a draft product from an exact name-and-slug payload for password-authenticated owner or operations administrators.';

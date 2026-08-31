alter table public.affiliate_users
  add column activation_pending boolean not null default false,
  add column activated_at timestamptz;

-- Existing invite-created memberships fail closed until the user proves a
-- password-authenticated session. Established non-invite memberships retain
-- their access and receive an activation timestamp during this migration.
update public.affiliate_users as membership
set
  active = false,
  activation_pending = true,
  activated_at = null,
  updated_at = now()
from auth.users as auth_user
where auth_user.id = membership.user_id
  and membership.active
  and (
    auth_user.invited_at is not null
    or nullif(btrim(coalesce(auth_user.encrypted_password, '')), '') is null
  );

update public.affiliate_users
set
  activated_at = now(),
  updated_at = now()
where active
  and not activation_pending
  and activated_at is null;

alter table public.affiliate_users
  alter column active set default false;

alter table public.affiliate_users
  add constraint affiliate_users_activation_state_valid
  check (
    (
      active
      and not activation_pending
      and activated_at is not null
    )
    or (
      not active
      and activation_pending
      and activated_at is null
    )
    or (
      not active
      and not activation_pending
    )
  );

drop index public.affiliate_users_one_active_partner_per_user;

create unique index affiliate_users_one_current_partner_per_user
  on public.affiliate_users (user_id)
  where active or activation_pending;

create or replace function public.current_partner_activation_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1
      from public.affiliate_users as membership
      where membership.user_id = auth.uid()
        and membership.active
        and not membership.activation_pending
        and membership.activated_at is not null
    ) then 'active'
    when exists (
      select 1
      from public.affiliate_users as membership
      where membership.user_id = auth.uid()
        and not membership.active
        and membership.activation_pending
        and membership.activated_at is null
    ) then 'pending'
    else 'none'
  end;
$$;

create or replace function public.complete_partner_activation()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  affected_rows integer;
begin
  if caller_id is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;

  if exists (
    select 1
    from public.affiliate_users as membership
    where membership.user_id = caller_id
      and membership.active
      and not membership.activation_pending
      and membership.activated_at is not null
  ) then
    return true;
  end if;

  if not exists (
    select 1
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where membership.user_id = caller_id
      and not membership.active
      and membership.activation_pending
      and membership.activated_at is null
      and affiliate.status in ('invited', 'active', 'paused')
  ) then
    raise exception 'no pending partner invitation' using errcode = '42501';
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
    raise exception 'partner activation requires a password-authenticated session'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = caller_id
      and auth_user.email_confirmed_at is not null
      and nullif(btrim(coalesce(auth_user.encrypted_password, '')), '') is not null
  ) then
    raise exception 'a verified password credential is required' using errcode = '55000';
  end if;

  update public.affiliate_users
  set
    active = true,
    activation_pending = false,
    activated_at = now(),
    updated_at = now()
  where user_id = caller_id
    and not active
    and activation_pending
    and activated_at is null;

  get diagnostics affected_rows = row_count;

  if affected_rows = 1 then
    return true;
  end if;

  if exists (
    select 1
    from public.affiliate_users
    where user_id = caller_id
      and active
      and not activation_pending
      and activated_at is not null
  ) then
    return true;
  end if;

  raise exception 'partner activation could not be completed' using errcode = '55000';
end;
$$;

revoke all on function public.current_partner_activation_status() from public, anon, authenticated;
revoke all on function public.complete_partner_activation() from public, anon, authenticated;
grant execute on function public.current_partner_activation_status() to authenticated;
grant execute on function public.complete_partner_activation() to authenticated;

comment on column public.affiliate_users.activation_pending is
  'True only while an invited member must prove password authentication.';
comment on column public.affiliate_users.activated_at is
  'First successful partner activation after password-authenticated sign-in.';
comment on function public.current_partner_activation_status() is
  'Returns active, pending, or none for the authenticated partner membership.';
comment on function public.complete_partner_activation() is
  'Activates the caller pending partner membership only from a password-authenticated Supabase session.';

begin;

create table public.platform_legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete restrict,
  registration_flow text not null check (registration_flow = 'public_partner_v1'),
  terms_version text not null check (terms_version = '2026-07-13'),
  terms_url text not null check (terms_url = 'https://kissmyapps.dev/terms'),
  privacy_version text not null check (privacy_version = '2026-07-13'),
  privacy_url text not null check (privacy_url = 'https://kissmyapps.dev/privacy'),
  age_confirmed boolean not null check (age_confirmed),
  accepted_at timestamptz not null default now(),
  unique (user_id, terms_version, privacy_version)
);

create index platform_legal_acceptances_user_id_idx
  on public.platform_legal_acceptances (user_id, affiliate_id, accepted_at desc);

alter table public.platform_legal_acceptances enable row level security;

alter table public.affiliates
  drop constraint affiliates_public_name_check,
  add constraint affiliates_public_name_check
    check (char_length(public_name) between 1 and 120);

create or replace function public.public_partner_registration_metadata_valid(p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_metadata) is distinct from 'object' then false
    else coalesce(
      (select count(*) from jsonb_object_keys(p_metadata)) = 7
      and not exists (
        select 1
        from jsonb_object_keys(p_metadata) as metadata_key(key)
        where metadata_key.key <> all(array[
          'registration_flow', 'full_name', 'terms_version', 'terms_url',
          'privacy_version', 'privacy_url', 'age_confirmed'
        ]::text[])
      )
      and p_metadata ->> 'registration_flow' = 'public_partner_v1'
      and jsonb_typeof(p_metadata -> 'full_name') = 'string'
      and p_metadata ->> 'full_name' = btrim(p_metadata ->> 'full_name')
      and char_length(p_metadata ->> 'full_name') between 1 and 120
      and p_metadata ->> 'terms_version' = '2026-07-13'
      and p_metadata ->> 'terms_url' = 'https://kissmyapps.dev/terms'
      and p_metadata ->> 'privacy_version' = '2026-07-13'
      and p_metadata ->> 'privacy_url' = 'https://kissmyapps.dev/privacy'
      and jsonb_typeof(p_metadata -> 'age_confirmed') = 'boolean'
      and p_metadata -> 'age_confirmed' = 'true'::jsonb,
      false
    )
  end;
$$;

create or replace function public.protect_platform_legal_acceptance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'platform legal acceptances cannot be updated' using errcode = 'P0001';
end;
$$;

create trigger platform_legal_acceptances_are_immutable
  before update on public.platform_legal_acceptances
  for each row execute function public.protect_platform_legal_acceptance();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  registration_metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (user_id, full_name)
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  )
  on conflict (user_id) do nothing;

  if registration_metadata ->> 'registration_flow' = 'public_partner_v1'
     and not public.public_partner_registration_metadata_valid(registration_metadata) then
    raise exception 'invalid public partner registration metadata' using errcode = '22023';
  end if;

  if not public.public_partner_registration_metadata_valid(registration_metadata) then
    return new;
  end if;

  insert into public.affiliates (
    public_name,
    slug,
    status
  ) values (
    registration_metadata ->> 'full_name',
    'partner-' || left(replace(new.id::text, '-', ''), 24),
    'invited'
  )
  returning id into partner_id;

  insert into public.affiliate_users (
    affiliate_id,
    user_id,
    role,
    active,
    activation_pending,
    activated_at
  ) values (
    partner_id,
    new.id,
    'owner',
    false,
    true,
    null
  );

  insert into public.affiliate_settings (affiliate_id, user_id)
  values (partner_id, new.id);

  insert into public.platform_legal_acceptances (
    user_id,
    affiliate_id,
    registration_flow,
    terms_version,
    terms_url,
    privacy_version,
    privacy_url,
    age_confirmed
  ) values (
    new.id,
    partner_id,
    registration_metadata ->> 'registration_flow',
    registration_metadata ->> 'terms_version',
    registration_metadata ->> 'terms_url',
    registration_metadata ->> 'privacy_version',
    registration_metadata ->> 'privacy_url',
    (registration_metadata ->> 'age_confirmed')::boolean
  );

  return new;
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
  is_public_registration boolean := false;
  has_password_method boolean := false;
  has_email_signup_method boolean := false;
  target_affiliate_id uuid;
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

  select membership.affiliate_id
  into target_affiliate_id
  from public.affiliate_users as membership
  join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
  where membership.user_id = caller_id
    and not membership.active
    and membership.activation_pending
    and membership.activated_at is null
    and affiliate.status in ('invited', 'active', 'paused');

  if target_affiliate_id is null then
    raise exception 'no pending partner invitation' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.platform_legal_acceptances as acceptance
    where acceptance.user_id = caller_id
      and acceptance.affiliate_id = target_affiliate_id
      and acceptance.registration_flow = 'public_partner_v1'
      and acceptance.terms_version = '2026-07-13'
      and acceptance.terms_url = 'https://kissmyapps.dev/terms'
      and acceptance.privacy_version = '2026-07-13'
      and acceptance.privacy_url = 'https://kissmyapps.dev/privacy'
      and acceptance.age_confirmed
  ) into is_public_registration;

  select
    coalesce(bool_or(authentication_method.entry ->> 'method' = 'password'), false),
    coalesce(bool_or(authentication_method.entry ->> 'method' = 'email/signup'), false)
  into has_password_method, has_email_signup_method
  from jsonb_array_elements(
    case
      when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
      else '[]'::jsonb
    end
  ) as authentication_method(entry);

  if not has_password_method
     and not (is_public_registration and has_email_signup_method) then
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

  if is_public_registration then
    update public.affiliates
    set
      status = 'active',
      updated_at = now()
    where id = target_affiliate_id
      and status = 'invited';
  end if;

  update public.affiliate_users
  set
    active = true,
    activation_pending = false,
    activated_at = now(),
    updated_at = now()
  where affiliate_id = target_affiliate_id
    and user_id = caller_id
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

revoke all on table public.platform_legal_acceptances
  from public, anon, authenticated, service_role;
revoke all on function public.public_partner_registration_metadata_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.protect_platform_legal_acceptance()
  from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user()
  from public, anon, authenticated, service_role;
revoke all on function public.complete_partner_activation()
  from public, anon, authenticated, service_role;
grant execute on function public.complete_partner_activation() to authenticated;

comment on table public.platform_legal_acceptances is
  'Lifecycle-scoped append-only evidence for the exact terms, privacy notice, and age attestation accepted during public registration; removed only with its Auth account.';
comment on function public.public_partner_registration_metadata_valid(jsonb) is
  'Validates the exact public_partner_v1 registration metadata contract without granting workspace access.';
comment on function public.complete_partner_activation() is
  'Activates invited partners only after password authentication; exact public registrations may also activate from a confirmed email signup session.';

commit;

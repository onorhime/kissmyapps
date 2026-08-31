begin;

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
  has_otp_method boolean := false;
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
    coalesce(bool_or(authentication_method.entry ->> 'method' = 'email/signup'), false),
    coalesce(bool_or(authentication_method.entry ->> 'method' = 'otp'), false)
  into has_password_method, has_email_signup_method, has_otp_method
  from jsonb_array_elements(
    case
      when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
      else '[]'::jsonb
    end
  ) as authentication_method(entry);

  if not has_password_method
     and not (
       is_public_registration
       and (has_email_signup_method or has_otp_method)
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

revoke all on function public.complete_partner_activation()
  from public, anon, authenticated, service_role;
grant execute on function public.complete_partner_activation() to authenticated;

comment on function public.complete_partner_activation() is
  'Activates invited partners after password authentication; exact accepted public registrations may also activate from direct OTP or PKCE email confirmation.';

commit;

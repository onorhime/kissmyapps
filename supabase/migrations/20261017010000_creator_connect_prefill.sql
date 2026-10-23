-- Keep the first account-create payload stable across retries, profile edits,
-- and ambiguous provider replies. Existing reservations retain the empty
-- snapshot used before prefill was implemented. No existing Stripe data is
-- updated by this migration or by reopening onboarding.
alter table public.external_creator_accounts
  add column account_creation_prefill jsonb not null default '{}'
  check (jsonb_typeof(account_creation_prefill) = 'object');

create or replace function public.reserve_creator_connect_account(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  a public.external_creator_accounts;
  partner public.affiliates;
  country_value text := p_input->>'country';
  actor uuid := (p_input->>'actor_user_id')::uuid;
  verified_email text;
  prefill jsonb := '{}';
begin
  select * into a from public.external_creator_accounts
    where id=(p_input->>'account_key')::uuid for update;
  if not found or country_value is null or country_value!~'^[A-Z]{2}$' then
    raise exception 'Invalid creator account reservation' using errcode='22023';
  end if;
  if not exists(select 1 from public.external_settlement_platforms
    where platform_account_id=a.platform_account_id and livemode=a.livemode and enabled) then
    raise exception 'Provider connection is disabled' using errcode='55000';
  end if;
  if a.country is not null and a.country<>country_value then
    raise exception 'Reserved account country changed' using errcode='22023';
  end if;
  -- actor is supplied only by the verified edge authentication, never by the
  -- browser. Validate its membership again before reading any profile data.
  if actor is not null and not exists(select 1 from public.affiliate_users m
    where m.affiliate_id=a.affiliate_id and m.user_id=actor
      and m.active and not m.activation_pending and m.activated_at is not null
      and m.role in ('owner','finance')) then
    raise exception 'Creator profile is outside this account scope' using errcode='42501';
  end if;
  if a.first_account_attempt_at is null and a.connect_account_id is null and actor is not null then
    select nullif(btrim(email),'') into verified_email from auth.users
      where id=actor and email_confirmed_at is not null;
    select * into partner from public.affiliates where id=a.affiliate_id;
    if verified_email is not null then
      prefill := prefill || jsonb_build_object('email',verified_email);
    end if;
    -- entity_type is an explicit saved profile choice. Neither a missing value
    -- nor a public/display name implies a legal entity or a personal identity.
    if partner.entity_type is not null then
      prefill := prefill || jsonb_build_object('business_type',partner.entity_type::text);
    end if;
    if partner.entity_type='company' and nullif(btrim(partner.legal_name),'') is not null then
      prefill := prefill || jsonb_build_object('company_name',btrim(partner.legal_name));
    end if;
    if nullif(btrim(partner.website_url),'') is not null then
      prefill := prefill || jsonb_build_object('website_url',btrim(partner.website_url));
    end if;
  end if;
  update public.external_creator_accounts set
    country=country_value,
    first_account_attempt_at=coalesce(first_account_attempt_at,clock_timestamp()),
    account_creation_prefill=case
      when first_account_attempt_at is null and connect_account_id is null then prefill
      else account_creation_prefill end
    where id=a.id returning * into a;
  return to_jsonb(a)||jsonb_build_object('account_key',a.id);
end $$;

-- Preserve the service-only boundary; authenticated users cannot submit identity
-- data or choose the actor for a reservation.
revoke all on function public.reserve_creator_connect_account(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_creator_connect_account(jsonb) to service_role;

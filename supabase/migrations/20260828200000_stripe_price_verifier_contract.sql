-- Authenticated Admin read boundary for server-side live Stripe Price checks.
-- The browser supplies only an offer UUID; expected commercial facts always
-- come from this database function and the attestation remains service-only.

create or replace function public.get_admin_billing_offer_verification_candidate(
  p_billing_offer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  offer public.billing_offers%rowtype;
begin
  perform public.assert_admin_password(
    array['owner', 'operations']::text[],
    'verify billing offers'
  );

  select * into offer
  from public.billing_offers as candidate
  where candidate.id = p_billing_offer_id;

  if offer.id is null then
    raise exception 'billing offer not found' using errcode = 'P0002';
  end if;
  if offer.status <> 'draft' then
    raise exception 'only a draft billing offer can be verified'
      using errcode = 'P0001';
  end if;
  if offer.stripe_price_id is null
     or offer.currency is null
     or offer.unit_amount_minor is null then
    raise exception 'complete the Stripe Price, currency, and amount before verification'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'billing_offer_id', offer.id,
    'stripe_price_id', offer.stripe_price_id,
    'currency', offer.currency,
    'unit_amount_minor', offer.unit_amount_minor,
    'billing_mode', offer.billing_mode
  );
end;
$$;

revoke all
  on function public.get_admin_billing_offer_verification_candidate(uuid)
  from public, anon, authenticated, service_role;
grant execute
  on function public.get_admin_billing_offer_verification_candidate(uuid)
  to authenticated;

comment on function public.get_admin_billing_offer_verification_candidate(uuid) is
  'Password-proven Owner/Operations read of server-owned draft offer facts for the live Stripe verifier.';

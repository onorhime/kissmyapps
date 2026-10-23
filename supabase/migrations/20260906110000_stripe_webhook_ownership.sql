-- Read-only, service-only ownership checks before the shared Stripe account's
-- events cross our persistence boundary. No customer or financial data returned.
begin;

create function public.stripe_webhook_owns_reference(
  p_kind text, p_reference text, p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  attempt_id uuid;
begin
  if p_kind is null or p_reference is null or p_metadata is null
     or jsonb_typeof(p_metadata) <> 'object'
     or octet_length(p_metadata::text) > 4096 then
    raise exception 'Invalid ownership query' using errcode = '22023';
  end if;
  if p_metadata->>'kma_attempt_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    attempt_id := (p_metadata->>'kma_attempt_id')::uuid;
  end if;

  if p_kind = 'checkout' and p_reference ~ '^cs_live_[A-Za-z0-9_]{8,160}$' then
    return exists (
      select 1 from public.checkout_attempts a
      where a.stripe_checkout_session_id = p_reference
      or (
        a.id = attempt_id
        and a.stripe_checkout_session_id is null
        and a.public_attempt_id = p_metadata->>'kma_public_attempt_id'
        and a.product_id::text = p_metadata->>'kma_product_id'
        and a.billing_offer_id::text = p_metadata->>'kma_offer_id'
        and a.acquisition_id::text = p_metadata->>'kma_acquisition_id'
        and a.click_record_id::text = p_metadata->>'kma_click_id'
        and a.unit_amount_minor::text = p_metadata->>'kma_expected_amount_minor'
        and lower(a.currency) = lower(p_metadata->>'kma_expected_currency')
      )
    );
  elsif p_kind = 'subscription' and p_reference ~ '^sub_[A-Za-z0-9_]{8,160}$' then
    return exists (
      select 1 from public.subscriptions s
      join public.stripe_subscription_evidence e on e.subscription_id = s.id
      where s.stripe_subscription_id = p_reference
    ) or exists (
      -- Subscription events can precede Checkout finalization/normalization.
      -- The Checkout attempt itself is always committed before calling Stripe.
      select 1 from public.checkout_attempts a
      where a.id = attempt_id
        and not exists (
          select 1 from public.stripe_subscription_evidence e
          join public.subscriptions s on s.id = e.subscription_id
          where e.checkout_attempt_id = a.id
            and s.stripe_subscription_id <> p_reference
        )
    );
  elsif p_kind = 'charge' and p_reference ~ '^ch_[A-Za-z0-9_]{8,160}$' then
    return exists (
      select 1 from public.stripe_transaction_evidence e
      where e.stripe_charge_id = p_reference
    );
  end if;
  raise exception 'Invalid ownership query' using errcode = '22023';
end;
$$;

revoke all on function public.stripe_webhook_owns_reference(text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.stripe_webhook_owns_reference(text,text,jsonb)
  to service_role;
comment on function public.stripe_webhook_owns_reference(text,text,jsonb) is
  'Service-only read-only ingress ownership check. Returns a boolean, never account or attribution details. Does not replace financial normalization validation.';

commit;

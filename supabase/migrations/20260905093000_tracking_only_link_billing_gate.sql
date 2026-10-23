begin;

-- The newer link validator already distinguishes commercial/tracking-only
-- issuance, but this older independent trigger still required Stripe for both.
create or replace function public.validate_active_link_billing_readiness()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'active' then
    if new.commercial_eligible then
      if not public.product_has_launch_ready_billing_offer(new.product_id) then
        raise exception 'active links require an active live-verified subscription offer' using errcode='P0001';
      end if;
    elsif not public.tracking_only_product_is_ready(new.product_id) then
      raise exception 'noncommercial links require a valid Owner-approved tracking-only product' using errcode='P0001';
    end if;
  end if;
  return new;
end;
$$;

commit;

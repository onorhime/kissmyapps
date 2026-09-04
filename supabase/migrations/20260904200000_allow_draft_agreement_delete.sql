-- Draft and awaiting-signature agreements may be deleted through the
-- password-proven admin RPC. The foundation trigger blocked every deletion
-- unconditionally; it now permits exactly the deletable subset and keeps
-- active and historical versions fully immutable, with signed bilateral
-- evidence preserved.

create or replace function public.protect_agreement_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_rules integer;
  has_fixed boolean;
  has_rate boolean;
  incompatible_rules integer;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'awaiting_signature') then
      raise exception 'agreement versions must begin in draft or awaiting_signature' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status not in ('draft', 'awaiting_signature') then
      raise exception 'agreement versions cannot be deleted' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.documents as document
      where document.agreement_id = old.id
        and document.affiliate_id = old.affiliate_id
        and document.status in ('signed', 'active')
    ) then
      raise exception 'a signed agreement document is preserved as evidence and cannot be deleted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
     or new.affiliate_id is distinct from old.affiliate_id
     or new.product_id is distinct from old.product_id
     or new.version is distinct from old.version
     or new.created_at is distinct from old.created_at then
    raise exception 'agreement version identity is immutable' using errcode = 'P0001';
  end if;

  if old.status in ('draft', 'awaiting_signature') then
    if new.status = 'active'
       or new.model is distinct from old.model
       or new.payout_currency is distinct from old.payout_currency then
      select
        count(*),
        coalesce(bool_or(rule.fixed_amount_minor is not null), false),
        coalesce(bool_or(rule.rate_basis_points is not null), false),
        count(*) filter (
          where (new.model <> 'hybrid' and rule.model <> new.model)
             or (
               rule.fixed_amount_minor is not null
               and rule.currency is distinct from new.payout_currency
             )
        )
      into active_rules, has_fixed, has_rate, incompatible_rules
      from public.commission_rules as rule
      where rule.agreement_id = old.id and rule.status = 'active';

      if incompatible_rules > 0 then
        raise exception 'active commission rules must match the agreement model and payout currency' using errcode = 'P0001';
      end if;
      if new.status = 'active' then
        if active_rules = 0 then
          raise exception 'an agreement requires at least one active commission rule' using errcode = 'P0001';
        end if;
        if new.model = 'hybrid' and not (has_fixed and has_rate) then
          raise exception 'a hybrid agreement requires active fixed and rate components' using errcode = 'P0001';
        end if;
      end if;
    end if;
    return new;
  end if;

  if old.status = 'active'
     and new.status in ('superseded', 'terminated', 'expired')
     and new.ends_at is not null
     and new.ends_at > new.starts_at
     and (to_jsonb(new) - 'status' - 'ends_at' - 'updated_at')
       = (to_jsonb(old) - 'status' - 'ends_at' - 'updated_at') then
    return new;
  end if;

  raise exception 'active and historical agreement versions are immutable' using errcode = 'P0001';
end;
$$;

comment on function public.protect_agreement_history() is
  'Preserves agreement history: identity is immutable, only draft or awaiting-signature versions can be deleted, and a signed bilateral document always blocks deletion as preserved evidence.';

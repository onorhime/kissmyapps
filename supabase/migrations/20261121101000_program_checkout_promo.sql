-- Affiliate self-serve, Phase 8, piece A: a program's checkout link and its creators' promo codes.
--
-- Checkout link. A program can sell one product through a checkout KissMyApps starts on the
-- merchant's own Stripe account (payment_mode 'kma_checkout') instead of the merchant's own
-- checkout. The merchant names the product, its price (one-time, monthly or yearly, in the
-- program's currency) and the page buyers see after paying. The program's landing page is
-- then https://kissmyapps.dev/checkout/<marketplace address>, set here and not editable, so a
-- creator's tracking link opens that checkout with the creator's click on it. The
-- program-checkout edge function asks program_checkout_target what to sell; the sale it
-- makes comes back through the webhook and record_program_sale like any other payment.
--
-- Promo codes. A program may give buyers a discount (buyer_discount_bps, 1% to 90%). Each
-- active creator then gets a code such as ANNA10, which the program-promo-worker makes as a
-- Stripe coupon and promotion code on the merchant's account (claim_program_promo_codes,
-- finish_program_promo_code). A sale paid with a creator's code goes to that creator, ahead of
-- any link click: record_program_sale ties it to one click on the creator's main link, written
-- for that sale and marked as a code use (program_promo_code_uses), so the sale keeps the
-- shape every commission function reads. Codes follow the published terms: publishing a new
-- discount retires the codes of the old one and issues new ones; a creator who leaves has
-- their code retired, and retired codes are switched off on Stripe.
--
-- The checkout product and the discount are terms: they are in the terms snapshot creators
-- accept, in the agreement, on the marketplace card and in the admin review, and changing them
-- is something to publish. A program that pays for sales only, sold through the merchant's
-- own checkout with no discount, has exactly the terms and agreement it had before this file.
--
-- New failure codes of workspace_program_save (SQLSTATE 22023, the code as DETAIL):
--   invalid_payment_mode, invalid_checkout, invalid_buyer_discount_bps;
-- and of workspace_program_submit and review_admin_program: stripe_charges_disabled.
begin;

-- Storage --------------------------------------------------------------------------------------

-- The checkout link's product, and the buyer discount. The product is the merchant's working
-- copy, like the rest of the form; what creators accepted is in the terms.
alter table public.affiliate_programs
  add column checkout_name text check (length(btrim(checkout_name)) between 1 and 80),
  add column checkout_amount_minor bigint check (checkout_amount_minor between 1 and 99999999),
  -- null: one payment; month or year: a subscription.
  add column checkout_interval text check (checkout_interval in ('month', 'year')),
  add column checkout_success_url text check (length(checkout_success_url) <= 2000 and checkout_success_url ~ '^https://'),
  add column buyer_discount_bps integer check (buyer_discount_bps between 100 and 9000),
  add constraint affiliate_program_checkout_shape check (
    payment_mode = 'kma_checkout'
    or (checkout_name is null and checkout_amount_minor is null and checkout_interval is null and checkout_success_url is null)),
  add constraint affiliate_program_checkout_complete check (
    payment_mode <> 'kma_checkout' or status in ('draft', 'changes_requested', 'archived')
    or (checkout_name is not null and checkout_amount_minor is not null and checkout_success_url is not null));

-- The promo worker's queue: when a code may be tried again, who holds it now, and whether a
-- retired code has been switched off on Stripe.
alter table public.program_promo_codes
  add column next_attempt_at timestamptz not null default now(),
  add column lease_until timestamptz,
  add column deactivated_at timestamptz,
  add column deactivate_attempts integer not null default 0 check (deactivate_attempts >= 0),
  add constraint program_promo_code_deactivated check (
    deactivated_at is null or (status = 'retired' and stripe_promotion_code_id is not null));
create index program_promo_codes_deactivate on public.program_promo_codes(retired_at)
  where status = 'retired' and stripe_promotion_code_id is not null and deactivated_at is null;

-- A sale paid with a creator's code is tied to one click on that creator's main link, made for
-- that sale at the moment it was paid. This marks the click as a code use. It counts as the
-- creator's click like any other (a buyer the creator brought), and it is never a tracking
-- click: no visitor opened a link.
create table public.program_promo_code_uses (
  click_record_id uuid primary key references public.clicks(id),
  code_id uuid not null references public.program_promo_codes(id),
  sale_id uuid not null unique references public.program_sales(id),
  created_at timestamptz not null default now()
);
create index program_promo_code_uses_code on public.program_promo_code_uses(code_id);
alter table public.program_promo_code_uses enable row level security;
revoke all on public.program_promo_code_uses from public, anon, authenticated, service_role;

-- Reading terms --------------------------------------------------------------------------------

-- How buyers pay, by a terms snapshot. Terms from before Phase 8 do not say: own checkout.
create function kma_internal.program_terms_payment_mode(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when p_terms->>'payment_mode' = 'kma_checkout' then 'kma_checkout' else 'own_checkout' end
$$;

-- The checkout link's product of a terms snapshot, {name, amount_minor, interval}, or null.
create function kma_internal.program_terms_checkout(p_terms jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when kma_internal.program_terms_payment_mode(p_terms) = 'kma_checkout'
      and jsonb_typeof(p_terms->'checkout') = 'object'
    then jsonb_build_object('name', p_terms->'checkout'->'name', 'amount_minor', p_terms->'checkout'->'amount_minor',
      'interval', coalesce(p_terms->'checkout'->'interval', 'null'::jsonb)) end
$$;

-- The buyer discount of a terms snapshot in basis points, or null.
create function kma_internal.program_terms_discount(p_terms jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_terms->'buyer_discount_bps') = 'number' then (p_terms->>'buyer_discount_bps')::integer end
$$;

-- Where a checkout-link program's creator links lead.
create function kma_internal.program_checkout_url(p_slug text) returns text
language sql immutable set search_path = '' as $$
  select 'https://kissmyapps.dev/checkout/' || p_slug
$$;

-- "$9.99 a month", "$99.00 a year", "$49.00, paid once".
create function kma_internal.program_checkout_price(p_amount bigint, p_currency text, p_interval text) returns text
language sql immutable set search_path = '' as $$
  select kma_internal.program_money(p_amount, p_currency)
    || case p_interval when 'month' then ' a month' when 'year' then ' a year' else ', paid once' end
$$;

-- The agreement --------------------------------------------------------------------------------

-- The definition from 20261119101000_program_reward_terms.sql, with the checkout link and the
-- promo code: section 2 says where the link goes when it opens a checkout, section 4 says how
-- a code credits a sale, and the summary names the product and the discount. Terms without
-- either give the Phase 2 document word for word, so the hash creators accepted stays.
create or replace function kma_internal.program_agreement(p_terms jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_program text := p_terms->>'program_name';
  v_brand text := coalesce(p_terms->>'brand_name', p_terms->>'program_name');
  v_url text := p_terms->>'landing_url';
  v_type text := p_terms->>'commission_type';
  v_duration text := p_terms->>'commission_duration';
  v_hold integer := (p_terms->>'hold_days')::integer;
  v_minimum bigint := (p_terms->>'minimum_payout_minor')::bigint;
  v_extra text := p_terms->>'extra_terms';
  v_checkout jsonb := kma_internal.program_terms_checkout(p_terms);
  v_discount integer := kma_internal.program_terms_discount(p_terms);
  v_price text;
  v_amount text;
  v_minimum_text text;
  v_window text;
  v_names text;
  v_cleared text;
  v_promote text;
  v_code_offer text;
  v_code_rule text;
  v_extra_summary jsonb := '[]'::jsonb;
  v_sections jsonb;
begin
  if kma_internal.program_terms_earn_from(p_terms) <> 'sales' then
    return kma_internal.program_agreement_rewards(p_terms);
  end if;
  if v_program is null or v_url is null or v_type is null or v_duration is null then
    return null;
  end if;
  v_amount := case v_type
    when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of'
    else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, p_terms->>'currency') || ' for'
  end;
  v_minimum_text := kma_internal.program_money(v_minimum, p_terms->>'currency');
  v_window := kma_internal.program_count((p_terms->>'attribution_window_days')::integer, 'day');
  v_names := case when v_brand = v_program then v_program else v_program || ' or ' || v_brand end;
  v_cleared := case when v_hold > 0 then 'once it has passed the hold' else 'once KissMyApps has confirmed the payment' end;
  v_promote := format('You promote %s. KissMyApps gives you your own link, and people who click it land on %s.', v_program, v_url);
  if v_checkout is not null then
    v_price := kma_internal.program_checkout_price((v_checkout->>'amount_minor')::bigint, p_terms->>'currency',
      v_checkout->>'interval');
    v_promote := format('You promote %s. KissMyApps gives you your own link, and people who click it go to a checkout '
      || 'where they can buy %s for %s.', v_program, v_checkout->>'name', v_price);
    v_extra_summary := v_extra_summary || jsonb_build_object('label', 'Product', 'value', (v_checkout->>'name') || ', ' || v_price);
  end if;
  if v_discount is not null then
    v_code_offer := format('KissMyApps also gives you your own promo code, which gives buyers %s off%s.',
      kma_internal.program_percent(v_discount),
      case when v_checkout is not null then ' and is applied by itself on the checkout your link opens' else '' end);
    v_code_rule := 'A sale paid with your promo code is credited to you, even if the customer did not click your link '
      || 'or clicked another creator''s link. Commission is worked out on what the customer paid after the discount.';
    v_extra_summary := v_extra_summary || jsonb_build_object('label', 'Buyer discount', 'value',
      kma_internal.program_percent(v_discount) || ' off with your code');
  end if;

  v_sections := jsonb_build_array(
    kma_internal.program_section('1. Who this agreement is between',
      format('This agreement is between you, the creator, and %s. KissMyApps is the platform the program runs on. '
        || 'It tracks sales and pays commission on behalf of %s.',
        case when v_brand = v_program then v_brand else format('%s, the business behind %s', v_brand, v_program) end, v_brand),
      format('You sign this agreement by accepting it on KissMyApps. %s agreed to these terms when it published them, '
        || 'so nobody needs to countersign.', v_brand)),
    kma_internal.program_section('2. What you promote',
      v_promote,
      case p_terms->>'approval_mode'
        when 'manual' then format('%s approves each creator. You can start once you have been approved.', v_brand)
        else 'You can start as soon as you accept this agreement.'
      end),
    kma_internal.program_section('3. Commission',
      case v_duration
        when 'first_payment' then format('You earn %s the first payment from each customer whose sale is credited to you. '
          || 'Renewals and other later payments from that customer do not earn commission.', v_amount)
        when 'months' then format('You earn %s every payment credited to you, for %s counted from the customer''s first payment. '
          || 'Payments after that do not earn commission.', v_amount,
          kma_internal.program_count((p_terms->>'commission_months')::integer, 'month'))
        else format('You earn %s every payment credited to you, with no time limit.', v_amount)
      end,
      'Section 4 explains which payments are credited to you.'),
    kma_internal.program_section('4. How a sale is credited to you', variadic array_remove(array[
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      v_code_offer,
      v_code_rule,
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.'],
      null)),
    kma_internal.program_section('5. Hold, refunds and chargebacks',
      case when v_hold > 0
        then format('Commission is held for %s after each payment before it can be paid out. This leaves time for refunds and disputes.',
          kma_internal.program_count(v_hold, 'day'))
        else 'There is no hold. Commission is ready for payout once KissMyApps has confirmed the payment.'
      end,
      'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
      'If that commission was already paid to you, the amount is taken out of your later commission.'),
    kma_internal.program_section('6. Payouts',
      format('KissMyApps pays your commission on behalf of %s, to the payout account you connect on KissMyApps.', v_brand),
      case when v_minimum > 0
        then format('Commission becomes payable %s. It is paid when your payable commission reaches %s.', v_cleared, v_minimum_text)
        else format('Commission becomes payable %s. There is no minimum payout.', v_cleared)
      end,
      format('KissMyApps pays out only from money %s has provided for commission. Until %s provides it, the commission is owed to you by %s, '
        || 'not by KissMyApps.', v_brand, v_brand, v_brand)),
    kma_internal.program_section('7. How you may promote',
      format('Be honest. Only say things about %s that are true.', v_program),
      'Tell your audience clearly that you earn commission when they buy through your link.',
      format('Do not send spam. Do not bid on the %s name in paid search ads. Do not buy through your own link. '
        || 'Do not send fake, automated or paid-for clicks or sign-ups.', v_names),
      'Sales that break these rules earn no commission.'),
    kma_internal.program_section(format('8. The %s name and logo', v_program),
      format('While this agreement is in force you may use the %s name and logo, unchanged, to promote it. '
        || 'Do not present yourself as %s or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
        v_program, v_brand)),
    kma_internal.program_section('9. Changes to these terms',
      format('%s can change these terms by publishing a new version. KissMyApps will ask you to accept it.', v_brand),
      'Commission you have already earned keeps the terms it was earned under.'),
    kma_internal.program_section('10. Ending this agreement',
      format('You or %s can end this agreement at any time.', v_brand),
      case when v_hold > 0
        then 'Commission you earned before it ended is still paid once it has passed the hold.'
        else 'Commission you earned before it ended is still paid.'
      end,
      'Payments made after it ends do not earn commission.'),
    kma_internal.program_section('11. Independent relationship',
      format('You promote %s as an independent creator. You are not an employee, agent or partner of %s or of KissMyApps, '
        || 'and you cannot make commitments on their behalf.', v_program, v_brand)));
  -- The brand's own words come last, exactly as typed, under this heading.
  if v_extra is not null then
    v_sections := v_sections || kma_internal.program_section(format('12. Additional terms from %s', v_brand),
      format('%s added the terms below. They are part of this agreement, but they cannot reduce commission you have already earned.', v_brand));
  end if;

  return jsonb_build_object(
    'title', v_program || ' Affiliate Agreement',
    'brand_name', v_brand,
    'program_name', v_program,
    'summary', jsonb_build_array(
        jsonb_build_object('label', 'Commission', 'value', kma_internal.program_commission_headline(p_terms)))
      || v_extra_summary
      || jsonb_build_array(
        jsonb_build_object('label', 'Attribution window', 'value', v_window),
        jsonb_build_object('label', 'Hold before payout', 'value',
          case when v_hold > 0 then kma_internal.program_count(v_hold, 'day') else 'None' end),
        jsonb_build_object('label', 'Minimum payout', 'value', case when v_minimum > 0 then v_minimum_text else 'None' end)),
    'sections', v_sections,
    'extra_terms', v_extra);
end $$;

-- The definition from 20261119101000_program_reward_terms.sql, with the checkout link and the
-- promo code for a program that pays for sales and events (a program that pays for events
-- only has neither: workspace_program_save refuses them). Terms without either give the
-- Phase 6 document word for word.
create or replace function kma_internal.program_agreement_rewards(p_terms jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_both boolean := kma_internal.program_terms_earn_from(p_terms) = 'both';
  v_program text := p_terms->>'program_name';
  v_brand text := coalesce(p_terms->>'brand_name', p_terms->>'program_name');
  v_url text := p_terms->>'landing_url';
  v_type text := p_terms->>'commission_type';
  v_duration text := p_terms->>'commission_duration';
  v_currency text := p_terms->>'currency';
  v_hold integer := (p_terms->>'hold_days')::integer;
  v_minimum bigint := (p_terms->>'minimum_payout_minor')::bigint;
  v_extra text := p_terms->>'extra_terms';
  v_rewards jsonb := kma_internal.program_terms_rewards(p_terms);
  v_checkout jsonb := kma_internal.program_terms_checkout(p_terms);
  v_discount integer := kma_internal.program_terms_discount(p_terms);
  -- What the creator is paid, as it reads inside a sentence and at the start of one.
  v_earnings text;
  v_earnings_first text;
  v_amount text;
  v_minimum_text text;
  v_window text;
  v_names text;
  v_reward_lines text[];
  v_summary jsonb;
  v_price text;
  v_promote text;
  v_code_offer text;
  v_code_rule text;
  v_extra_summary jsonb := '[]'::jsonb;
  s jsonb := '[]'::jsonb;
begin
  if v_program is null or v_url is null or jsonb_array_length(v_rewards) = 0
    or (v_both and (v_type is null or v_duration is null)) then
    return null;
  end if;
  v_earnings := case when v_both then 'commission and rewards' else 'rewards' end;
  v_earnings_first := case when v_both then 'Commission and rewards' else 'Rewards' end;
  v_minimum_text := kma_internal.program_money(v_minimum, v_currency);
  v_window := kma_internal.program_count((p_terms->>'attribution_window_days')::integer, 'day');
  v_names := case when v_brand = v_program then v_program else v_program || ' or ' || v_brand end;
  select array_agg(format('%s: %s.', x.reward->>'label',
      kma_internal.program_money((x.reward->>'amount_minor')::bigint, v_currency)) order by x.place)
  into v_reward_lines
  from jsonb_array_elements(v_rewards) with ordinality x(reward, place);
  v_promote := format('You promote %s. KissMyApps gives you your own link, and people who click it land on %s.', v_program, v_url);
  if v_checkout is not null then
    v_price := kma_internal.program_checkout_price((v_checkout->>'amount_minor')::bigint, v_currency, v_checkout->>'interval');
    v_promote := format('You promote %s. KissMyApps gives you your own link, and people who click it go to a checkout '
      || 'where they can buy %s for %s.', v_program, v_checkout->>'name', v_price);
    v_extra_summary := v_extra_summary || jsonb_build_object('label', 'Product', 'value', (v_checkout->>'name') || ', ' || v_price);
  end if;
  if v_discount is not null and v_both then
    v_code_offer := format('KissMyApps also gives you your own promo code, which gives buyers %s off%s.',
      kma_internal.program_percent(v_discount),
      case when v_checkout is not null then ' and is applied by itself on the checkout your link opens' else '' end);
    v_code_rule := 'A sale paid with your promo code is credited to you, even if the customer did not click your link '
      || 'or clicked another creator''s link. Commission is worked out on what the customer paid after the discount.';
    v_extra_summary := v_extra_summary || jsonb_build_object('label', 'Buyer discount', 'value',
      kma_internal.program_percent(v_discount) || ' off with your code');
  end if;

  s := kma_internal.program_section_add(s, 'Who this agreement is between',
    format('This agreement is between you, the creator, and %s. KissMyApps is the platform the program runs on. '
      || 'It tracks what people do after they open your link and pays your %s on behalf of %s.',
      case when v_brand = v_program then v_brand else format('%s, the business behind %s', v_brand, v_program) end,
      v_earnings, v_brand),
    format('You sign this agreement by accepting it on KissMyApps. %s agreed to these terms when it published them, '
      || 'so nobody needs to countersign.', v_brand));
  s := kma_internal.program_section_add(s, 'What you promote',
    v_promote,
    case p_terms->>'approval_mode'
      when 'manual' then format('%s approves each creator. You can start once you have been approved.', v_brand)
      else 'You can start as soon as you accept this agreement.'
    end);

  if v_both then
    v_amount := case v_type
      when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of'
      else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, v_currency) || ' for'
    end;
    s := kma_internal.program_section_add(s, 'Commission',
      case v_duration
        when 'first_payment' then format('You earn %s the first payment from each customer whose sale is credited to you. '
          || 'Renewals and other later payments from that customer do not earn commission.', v_amount)
        when 'months' then format('You earn %s every payment credited to you, for %s counted from the customer''s first payment. '
          || 'Payments after that do not earn commission.', v_amount,
          kma_internal.program_count((p_terms->>'commission_months')::integer, 'month'))
        else format('You earn %s every payment credited to you, with no time limit.', v_amount)
      end,
      'Section 4 explains which payments are credited to you.');
    s := kma_internal.program_section_add(s, 'How a sale is credited to you',
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      v_code_offer,
      v_code_rule,
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.');
  end if;

  s := kma_internal.program_section_add(s, 'Rewards', variadic
    array[case when v_both
      then 'You also earn a reward when a person who opened your link does one of the things below, whether or not they buy. '
        || 'Each reward is a fixed amount.'
      else 'You earn a reward when a person who opened your link does one of the things below. Each reward is a fixed amount.'
    end]
    || v_reward_lines
    || array['Each reward is earned once per person. If the same person does the same thing again, you earn nothing more for it.',
      case when not v_both then 'This program pays these rewards only. Sales made through your link earn no commission.' end]);
  s := kma_internal.program_section_add(s, 'How a reward is credited to you',
    format('A reward is credited to you when a person opens your link and, within %s of that click, does what the reward is for.',
      v_window),
    'If that person opened more than one creator''s link in that time, the reward goes to the last link they opened.',
    format('Only actions that KissMyApps has tracked count. Your own actions earn nothing: you cannot earn a reward by signing up '
      || 'to %s or using it yourself.', v_program));
  s := kma_internal.program_section_add(s, 'Limits on rewards',
    format('%s sets a budget for rewards for each calendar month and can change it at any time. '
      || 'KissMyApps sets a limit on what one creator can earn in rewards in one day.', v_brand),
    'Rewards stop when the monthly budget or your daily limit is reached, and start again with the next month or the next day. '
      || 'Actions in between earn no reward.');

  if v_both then
    s := kma_internal.program_section_add(s, 'Hold, refunds and chargebacks',
      case when v_hold > 0
        then format('Commission is held for %s after each payment before it can be paid out. This leaves time for refunds and disputes.',
          kma_internal.program_count(v_hold, 'day'))
        else 'There is no hold. Commission is ready for payout once KissMyApps has confirmed the payment.'
      end,
      'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
      'If that commission was already paid to you, the amount is taken out of what you earn later.');
  end if;
  if v_hold > 0 then
    s := kma_internal.program_section_add(s, 'Hold and rejected rewards',
      format('A reward is held for %s after it is earned before it can be paid out.', kma_internal.program_count(v_hold, 'day')),
      format('During the hold %s may reject a reward that is fake, a duplicate or your own action. '
        || 'A rejected reward is cancelled and pays nothing.', v_brand));
  else
    s := kma_internal.program_section_add(s, 'Hold on rewards',
      'Rewards are not held. A reward is ready for payout once KissMyApps has recorded it.');
  end if;

  s := kma_internal.program_section_add(s, 'Payouts',
    format('KissMyApps pays your %s on behalf of %s, to the payout account you connect on KissMyApps.', v_earnings, v_brand),
    format('%s become payable %s. %s', v_earnings_first,
      case when v_hold > 0 then 'once they have passed the hold' else 'once KissMyApps has confirmed them' end,
      case when v_minimum > 0
        then format('They are paid when what is payable to you reaches %s.', v_minimum_text)
        else 'There is no minimum payout.'
      end),
    format('KissMyApps pays out only from money %s has provided for %s. Until %s provides it, what you have earned is owed to you by %s, '
      || 'not by KissMyApps.', v_brand, v_earnings, v_brand, v_brand));
  s := kma_internal.program_section_add(s, 'How you may promote',
    format('Be honest. Only say things about %s that are true.', v_program),
    'Tell your audience clearly that you earn money when they use your link.',
    format('Do not send spam. Do not bid on the %s name in paid search ads. Do not use or buy through your own link. '
      || 'Do not send fake, automated or paid-for clicks, sign-ups or other actions.', v_names),
    case when v_both then 'Sales and actions that break these rules earn nothing.'
      else 'Actions that break these rules earn no reward.' end);
  s := kma_internal.program_section_add(s, format('The %s name and logo', v_program),
    format('While this agreement is in force you may use the %s name and logo, unchanged, to promote it. '
      || 'Do not present yourself as %s or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
      v_program, v_brand));
  s := kma_internal.program_section_add(s, 'Changes to these terms',
    format('%s can change these terms by publishing a new version. KissMyApps will ask you to accept it.', v_brand),
    'What you have already earned keeps the terms it was earned under.');
  s := kma_internal.program_section_add(s, 'Ending this agreement',
    format('You or %s can end this agreement at any time.', v_brand),
    case when v_hold > 0
      then 'What you earned before it ended is still paid once it has passed the hold.'
      else 'What you earned before it ended is still paid.'
    end,
    case when v_both then 'Payments and actions that happen after it ends earn nothing.'
      else 'Actions that happen after it ends earn no reward.' end);
  s := kma_internal.program_section_add(s, 'Independent relationship',
    format('You promote %s as an independent creator. You are not an employee, agent or partner of %s or of KissMyApps, '
      || 'and you cannot make commitments on their behalf.', v_program, v_brand));
  -- The brand's own words come last, exactly as typed, under this heading.
  if v_extra is not null then
    s := kma_internal.program_section_add(s, format('Additional terms from %s', v_brand),
      format('%s added the terms below. They are part of this agreement, but they cannot reduce what you have already earned.', v_brand));
  end if;

  v_summary := jsonb_build_array(
    jsonb_build_object('label', 'Rewards', 'value',
      kma_internal.program_commission_headline(p_terms || '{"earn_from":"events"}'::jsonb)),
    jsonb_build_object('label', 'Attribution window', 'value', v_window),
    jsonb_build_object('label', 'Hold before payout', 'value',
      case when v_hold > 0 then kma_internal.program_count(v_hold, 'day') else 'None' end),
    jsonb_build_object('label', 'Minimum payout', 'value', case when v_minimum > 0 then v_minimum_text else 'None' end));
  if v_both then
    v_summary := jsonb_build_array(jsonb_build_object('label', 'Commission', 'value',
      kma_internal.program_commission_headline(p_terms || '{"earn_from":"sales"}'::jsonb))) || v_extra_summary || v_summary;
  elsif v_checkout is not null then
    v_summary := v_extra_summary || v_summary;
  end if;
  return jsonb_build_object(
    'title', v_program || ' Affiliate Agreement',
    'brand_name', v_brand,
    'program_name', v_program,
    'summary', v_summary,
    'sections', s,
    'extra_terms', v_extra);
end $$;

-- Reading a program ----------------------------------------------------------------------------

-- The definition from 20261119101000_program_reward_terms.sql, with how buyers pay: a
-- checkout-link program's terms also carry payment_mode and its product {name, amount_minor,
-- interval} (the page after payment is the merchant's to change and is not a term), and a
-- program with a discount carries buyer_discount_bps. Neither key is written for a program
-- without them, so its terms stay what they were. A checkout-link program has no terms until
-- its product is complete.
create or replace function kma_internal.program_terms(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'program_name', p.name,
    'brand_name', coalesce(
      kma_internal.workspace_stripe_connection(p.workspace_id)->>'business_name',
      (select t.terms->>'brand_name' from public.affiliate_program_terms t
        where t.program_id = p.id and t.version = p.live_terms_version),
      p.name),
    'landing_url', p.landing_url,
    'commission_type', case when e.sales then p.commission_type end,
    'commission_rate_bps', case when e.sales then p.commission_rate_bps end,
    'commission_fixed_minor', case when e.sales then p.commission_fixed_minor end,
    'currency', p.currency,
    'commission_duration', case when e.sales then p.commission_duration end,
    'commission_months', case when e.sales then p.commission_months end,
    'attribution_window_days', p.attribution_window_days,
    'hold_days', p.hold_days,
    'minimum_payout_minor', p.minimum_payout_minor,
    'approval_mode', p.approval_mode,
    'extra_terms', p.extra_terms,
    'earn_from', p.earn_from,
    'rewards', case when e.events then p.rewards else '[]'::jsonb end)
    || case when p.payment_mode = 'kma_checkout' then jsonb_build_object('payment_mode', 'kma_checkout',
        'checkout', jsonb_build_object('name', p.checkout_name, 'amount_minor', p.checkout_amount_minor,
          'interval', p.checkout_interval))
      else '{}'::jsonb end
    || case when p.buyer_discount_bps is not null then jsonb_build_object('buyer_discount_bps', p.buyer_discount_bps)
      else '{}'::jsonb end
  from (select p.earn_from <> 'events' as sales, p.earn_from <> 'sales' as events) e
  where p.name is not null and p.landing_url is not null
    and (not e.sales or (p.commission_type is not null and p.commission_duration is not null))
    and (not e.events or (jsonb_array_length(p.rewards) > 0 and p.reward_budget_minor is not null))
    and (p.payment_mode <> 'kma_checkout'
      or (p.checkout_name is not null and p.checkout_amount_minor is not null and p.checkout_success_url is not null))
$$;

-- The definition from 20261119101000_program_reward_terms.sql, with the checkout link: for a
-- checkout-link program the checklist item landing_page is its product (name, price, page
-- after payment) and stripe_connected needs a Stripe account that can take payments
-- (charges enabled). A change of payment mode, product or discount is something to publish.
create or replace function kma_internal.program_check(
  p public.affiliate_programs,
  out stripe_connected boolean, out details boolean, out landing_page boolean, out commission boolean,
  out complete boolean, out terms jsonb, out agreement jsonb, out sha256 text,
  out agreement_read boolean, out has_unpublished_changes boolean
) language plpgsql stable set search_path = '' as $$
declare
  v_live public.affiliate_program_terms;
  v_commission boolean;
  v_rewards boolean;
  v_connection jsonb := kma_internal.workspace_stripe_connection(p.workspace_id);
  v_kma boolean := p.payment_mode = 'kma_checkout';
begin
  stripe_connected := v_connection is not null
    and (not v_kma or coalesce((v_connection->>'charges_enabled')::boolean, false));
  details := p.name is not null and p.category is not null and p.tagline is not null;
  landing_page := p.landing_url is not null and (not v_kma
    or (p.checkout_name is not null and p.checkout_amount_minor is not null and p.checkout_success_url is not null));
  v_commission := p.commission_type is not null and p.commission_duration is not null;
  v_rewards := coalesce(jsonb_array_length(p.rewards) > 0 and p.reward_budget_minor is not null, false);
  commission := case p.earn_from
    when 'events' then v_rewards
    when 'both' then v_commission and v_rewards
    else v_commission
  end;
  complete := details and landing_page and commission;
  terms := kma_internal.program_terms(p);
  agreement := kma_internal.program_agreement(terms);
  sha256 := kma_internal.program_agreement_sha256(agreement);
  agreement_read := sha256 is not null and p.agreement_read_sha256 is not distinct from sha256;
  select t.* into v_live from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version;
  -- The agreement names a reward by its label and amount. The event behind a reward is in
  -- the terms only, so a change of it alone is also something to publish.
  has_unpublished_changes := p.status in ('live', 'paused') and (
    sha256 is distinct from v_live.agreement_sha256
    or (terms is not null and (
      terms->>'earn_from' is distinct from kma_internal.program_terms_earn_from(v_live.terms)
      or terms->'rewards' is distinct from kma_internal.program_terms_rewards(v_live.terms)
      or kma_internal.program_terms_payment_mode(terms) is distinct from kma_internal.program_terms_payment_mode(v_live.terms)
      or kma_internal.program_terms_checkout(terms) is distinct from kma_internal.program_terms_checkout(v_live.terms)
      or kma_internal.program_terms_discount(terms) is distinct from kma_internal.program_terms_discount(v_live.terms))));
end $$;

-- A creator's promo code as the creator reads it: {code, discount_bps, status} with status
-- pending (being made), active or failed; null when they have none (the program gives no
-- discount, or they are not an active member).
create function kma_internal.program_promo_code_json(p_program uuid, p_member uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('code', c.code, 'discount_bps', c.discount_bps, 'status', c.status)
  from public.program_promo_codes c
  where c.program_id = p_program and c.member_id = p_member and c.status <> 'retired'
$$;

-- The definition from 20261120102000_program_app_installs.sql, with how buyers pay:
-- payment_mode, checkout ({name, amount_minor, interval, success_url} for a checkout-link
-- program, else null), buyer_discount_bps, and promo_codes: {active, pending, failed,
-- last_error} over the creators' codes that are not retired, where last_error is the plain
-- reason (a short code such as code_taken, never Stripe's message) the most recently failed
-- code failed with, else null. promo_codes is null when the program gives no discount: none in
-- the working copy and no code left from the published terms. Merchant answers only.
create or replace function kma_internal.program_json(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'revision', p.revision, 'status', p.status, 'pause_reason', p.pause_reason,
    'review_note', p.review_note, 'slug', p.slug,
    'name', p.name, 'category', p.category, 'tagline', p.tagline, 'logo_path', p.logo_path,
    'landing_url', p.landing_url,
    'commission_type', p.commission_type, 'commission_rate_bps', p.commission_rate_bps,
    'commission_fixed_minor', p.commission_fixed_minor, 'currency', p.currency,
    'commission_duration', p.commission_duration, 'commission_months', p.commission_months,
    'attribution_window_days', p.attribution_window_days, 'hold_days', p.hold_days,
    'minimum_payout_minor', p.minimum_payout_minor,
    'approval_mode', p.approval_mode, 'marketplace_listed', p.marketplace_listed, 'extra_terms', p.extra_terms)
    || jsonb_build_object(
    'earn_from', p.earn_from, 'rewards', p.rewards, 'reward_budget_minor', p.reward_budget_minor,
    'agreement_read', c.agreement_read,
    'has_unpublished_changes', c.has_unpublished_changes,
    'live_terms_version', p.live_terms_version,
    'submitted_at', p.submitted_at, 'first_published_at', p.first_published_at, 'updated_at', p.updated_at)
    || jsonb_build_object('app_link', kma_internal.program_app_link(p))
    || jsonb_build_object(
    'payment_mode', p.payment_mode,
    'checkout', case when p.payment_mode = 'kma_checkout' then jsonb_build_object(
      'name', p.checkout_name, 'amount_minor', p.checkout_amount_minor, 'interval', p.checkout_interval,
      'success_url', p.checkout_success_url) end,
    'buyer_discount_bps', p.buyer_discount_bps,
    'promo_codes', (select case when p.buyer_discount_bps is not null or count(*) > 0 then jsonb_build_object(
        'active', count(*) filter (where x.status = 'active'),
        'pending', count(*) filter (where x.status = 'pending'),
        'failed', count(*) filter (where x.status = 'failed'),
        'last_error', (select f.last_error from public.program_promo_codes f
          where f.program_id = p.id and f.status = 'failed'
          order by f.next_attempt_at desc, f.created_at desc, f.id limit 1)) end
      from public.program_promo_codes x where x.program_id = p.id and x.status <> 'retired'))
  from kma_internal.program_check(p) c
$$;

-- The definition from 20261120102000_program_app_installs.sql, with stripe_charges_enabled:
-- whether the connected Stripe account can take payments, which a checkout link needs.
create or replace function kma_internal.program_state(p_workspace uuid, p_role text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.affiliate_programs := kma_internal.program_of(p_workspace);
  c record;
  v_connection jsonb := kma_internal.workspace_stripe_connection(p_workspace);
  v_checklist jsonb;
  v_app_links boolean := exists (select 1 from kma_internal.program_app_link_rows(p_workspace));
  v_charges boolean := coalesce((v_connection->>'charges_enabled')::boolean, false);
begin
  if p.id is null then
    return jsonb_build_object(
      'can_manage', p_role in ('owner', 'admin'),
      'stripe_connected', v_connection is not null,
      'stripe_charges_enabled', v_charges,
      'brand_name', v_connection->>'business_name',
      'events_available', kma_internal.program_money_enabled(),
      'app_links_available', v_app_links,
      'program', null,
      'checklist', jsonb_build_object('stripe_connected', v_connection is not null, 'details', false,
        'landing_page', false, 'commission', false, 'agreement_read', false),
      'can_submit', false);
  end if;
  select * into c from kma_internal.program_check(p);
  v_checklist := jsonb_build_object('stripe_connected', c.stripe_connected, 'details', c.details,
    'landing_page', c.landing_page, 'commission', c.commission, 'agreement_read', c.agreement_read);
  return jsonb_build_object(
    'can_manage', p_role in ('owner', 'admin'),
    'stripe_connected', c.stripe_connected,
    'stripe_charges_enabled', v_charges,
    'brand_name', v_connection->>'business_name',
    'events_available', kma_internal.program_money_enabled(),
    'app_links_available', v_app_links,
    'program', kma_internal.program_json(p),
    'checklist', v_checklist,
    -- A first listing can be sent for review; a published program only has something to
    -- publish when its terms changed.
    'can_submit', c.stripe_connected and c.complete and c.agreement_read
      and (p.status in ('draft', 'changes_requested') or c.has_unpublished_changes));
end $$;

-- Changing a program ---------------------------------------------------------------------------

-- The checkout link's product from the form: absent leaves it unchanged, null clears it, and
-- an object sets the keys it has (name, amount_minor, interval, success_url; absent: unchanged,
-- null: cleared). Anything wrong is invalid_checkout.
create function kma_internal.program_input_checkout(p_input jsonb, p public.affiliate_programs,
  out o_name text, out o_amount_minor bigint, out o_interval text, out o_success_url text)
language plpgsql stable set search_path = '' as $$
declare
  v jsonb := p_input->'checkout';
begin
  o_name := p.checkout_name;
  o_amount_minor := p.checkout_amount_minor;
  o_interval := p.checkout_interval;
  o_success_url := p.checkout_success_url;
  if not p_input ? 'checkout' then
    return;
  end if;
  if jsonb_typeof(v) = 'null' then
    o_name := null; o_amount_minor := null; o_interval := null; o_success_url := null;
    return;
  end if;
  if jsonb_typeof(v) <> 'object'
    or exists (select 1 from jsonb_object_keys(v) k where k not in ('name', 'amount_minor', 'interval', 'success_url')) then
    perform kma_internal.program_fail('invalid_checkout', 'The product has fields that cannot be saved');
  end if;
  if v ? 'name' then
    if jsonb_typeof(v->'name') not in ('string', 'null') then
      perform kma_internal.program_fail('invalid_checkout', 'The product name must be text');
    end if;
    o_name := nullif(btrim(coalesce(v->>'name', ''), E' \t\r\n'), '');
    if length(o_name) > 80 or o_name ~ '[\x01-\x1f\x7f]' then
      perform kma_internal.program_fail('invalid_checkout', 'The product name must be up to 80 characters on one line');
    end if;
  end if;
  if v ? 'amount_minor' then
    if jsonb_typeof(v->'amount_minor') = 'null' then
      o_amount_minor := null;
    elsif jsonb_typeof(v->'amount_minor') <> 'number' or v->>'amount_minor' !~ '^[0-9]{1,8}$'
      or (v->>'amount_minor')::bigint not between 1 and 99999999 then
      perform kma_internal.program_fail('invalid_checkout', 'The price must be a whole amount from 1 to 99999999');
    else
      o_amount_minor := (v->>'amount_minor')::bigint;
    end if;
  end if;
  if v ? 'interval' then
    if jsonb_typeof(v->'interval') = 'null' then
      o_interval := null;
    elsif jsonb_typeof(v->'interval') <> 'string' or v->>'interval' not in ('month', 'year') then
      perform kma_internal.program_fail('invalid_checkout', 'The product is paid once, every month or every year');
    else
      o_interval := v->>'interval';
    end if;
  end if;
  if v ? 'success_url' then
    if jsonb_typeof(v->'success_url') not in ('string', 'null') then
      perform kma_internal.program_fail('invalid_checkout', 'The page after payment must be an address');
    end if;
    o_success_url := nullif(btrim(coalesce(v->>'success_url', ''), E' \t\r\n'), '');
    if o_success_url is not null and not coalesce(public.is_production_https_url(o_success_url, true), false) then
      perform kma_internal.program_fail('invalid_checkout', 'The page after payment must be a public https address');
    end if;
  end if;
end $$;

-- The definition from 20261119101000_program_reward_terms.sql, with how buyers pay:
--   payment_mode: own_checkout (the default) or kma_checkout. A checkout-link program's
--     landing page is its checkout address and a landing_url sent with it is ignored;
--     going back to the merchant's own checkout clears that address, so the form must send
--     the merchant's own landing page (a published program cannot be left without one).
--   checkout: the checkout link's product, kept only for kma_checkout.
--   buyer_discount_bps: null (no promo codes) or 100 to 9000.
-- A program that pays for events only sells nothing through its link: it cannot use a
-- checkout link or give a buyer discount.
create or replace function kma_internal.program_apply_input(p public.affiliate_programs, p_input jsonb)
returns public.affiliate_programs language plpgsql stable set search_path = '' as $$
declare
  n public.affiliate_programs := p;
  v_published boolean := p.status in ('live', 'paused');
  v_checkout record;
begin
  -- Product card
  n.name := kma_internal.program_input_text(p_input, 'name', p.name, 120);
  n.category := kma_internal.program_input_choice(p_input, 'category', p.category, array[
    'education', 'productivity', 'health_fitness', 'lifestyle', 'finance', 'entertainment', 'games', 'social',
    'utilities', 'business', 'shopping', 'travel', 'food_drink', 'developer_tools', 'other']);
  n.tagline := kma_internal.program_input_text(p_input, 'tagline', p.tagline, 160);
  n.logo_path := kma_internal.program_input_text(p_input, 'logo_path', p.logo_path, 300);
  if n.logo_path is distinct from p.logo_path and n.logo_path is not null and (
    left(n.logo_path, 37) <> p.workspace_id::text || '/' or length(n.logo_path) < 38
    or not exists (select 1 from storage.objects o where o.bucket_id = 'program-logos' and o.name = n.logo_path)
  ) then
    perform kma_internal.program_fail('invalid_logo_path', 'Upload the logo before saving it');
  end if;

  -- How buyers pay, and so where creator links lead.
  n.payment_mode := kma_internal.program_input_choice(p_input, 'payment_mode', p.payment_mode,
    array['own_checkout', 'kma_checkout'], 'own_checkout');
  if n.payment_mode = 'kma_checkout' then
    n.landing_url := kma_internal.program_checkout_url(n.slug);
    select * into v_checkout from kma_internal.program_input_checkout(p_input, p);
    n.checkout_name := v_checkout.o_name;
    n.checkout_amount_minor := v_checkout.o_amount_minor;
    n.checkout_interval := v_checkout.o_interval;
    n.checkout_success_url := v_checkout.o_success_url;
  else
    if p_input ? 'checkout' and jsonb_typeof(p_input->'checkout') not in ('object', 'null') then
      perform kma_internal.program_fail('invalid_checkout', 'The product has fields that cannot be saved');
    end if;
    n.checkout_name := null;
    n.checkout_amount_minor := null;
    n.checkout_interval := null;
    n.checkout_success_url := null;
    n.landing_url := kma_internal.program_input_text(p_input, 'landing_url',
      case when p.payment_mode = 'kma_checkout' then null else p.landing_url end, 2000);
    if n.landing_url is distinct from p.landing_url and n.landing_url is not null
      and not public.is_production_https_url(n.landing_url, true) then
      perform kma_internal.program_fail('invalid_landing_url', 'The landing page must be a public https address');
    end if;
  end if;
  n.buyer_discount_bps := kma_internal.program_input_int(p_input, 'buyer_discount_bps', p.buyer_discount_bps, 100, 9000);

  if p_input ? 'marketplace_listed' then
    if jsonb_typeof(p_input->'marketplace_listed') not in ('boolean', 'null') then
      perform kma_internal.program_fail('invalid_marketplace_listed', 'marketplace_listed must be true or false');
    end if;
    n.marketplace_listed := coalesce((p_input->>'marketplace_listed')::boolean, true);
  end if;

  -- Commission
  n.commission_type := kma_internal.program_input_choice(p_input, 'commission_type', p.commission_type, array['percent', 'fixed']);
  n.commission_rate_bps := kma_internal.program_input_int(p_input, 'commission_rate_bps', p.commission_rate_bps, 1, 10000);
  n.commission_fixed_minor := kma_internal.program_input_int(p_input, 'commission_fixed_minor', p.commission_fixed_minor, 1, 100000000);
  n.commission_duration := kma_internal.program_input_choice(p_input, 'commission_duration', p.commission_duration,
    array['first_payment', 'months', 'lifetime']);
  n.commission_months := kma_internal.program_input_int(p_input, 'commission_months', p.commission_months, 1, 36);
  n.currency := kma_internal.program_input_text(p_input, 'currency', p.currency, 3);
  n.currency := coalesce(n.currency, 'USD');
  -- Amounts are stored in hundredths, so only currencies that Stripe counts in plain
  -- hundredths are taken: none with zero or three decimals, or with whole-unit rules.
  if n.currency !~ '^[A-Z]{3}$' or n.currency = any(array[
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
    'BHD', 'JOD', 'KWD', 'OMR', 'TND', 'ISK', 'HUF', 'TWD']) then
    perform kma_internal.program_fail('invalid_currency', 'Choose a currency with two decimal places');
  end if;

  -- What creators earn from. Paying for events needs program money: choosing it is refused
  -- while that is switched off. The rewards and the budget are kept whatever earn_from is.
  n.earn_from := kma_internal.program_input_choice(p_input, 'earn_from', p.earn_from, array['sales', 'events', 'both'], 'sales');
  if n.earn_from <> 'sales' and n.earn_from is distinct from p.earn_from and not kma_internal.program_money_enabled() then
    perform kma_internal.program_fail('events_unavailable', 'Paying for events is not available yet');
  end if;
  n.rewards := kma_internal.program_input_rewards(p_input, p.rewards);
  n.reward_budget_minor := kma_internal.program_input_int(p_input, 'reward_budget_minor', p.reward_budget_minor, 100, 100000000);
  if n.reward_budget_minor < (select max((r->>'amount_minor')::bigint) from jsonb_array_elements(n.rewards) r) then
    perform kma_internal.program_fail('invalid_reward_budget_minor', 'The monthly budget must cover at least the largest reward');
  end if;
  if n.earn_from = 'events' and n.payment_mode = 'kma_checkout' then
    perform kma_internal.program_fail('invalid_payment_mode', 'A program that pays for events only cannot sell through a checkout link');
  end if;
  if n.earn_from = 'events' and n.buyer_discount_bps is not null then
    perform kma_internal.program_fail('invalid_buyer_discount_bps', 'A program that pays for events only has no promo codes');
  end if;

  -- More options
  n.attribution_window_days := kma_internal.program_input_int(p_input, 'attribution_window_days', p.attribution_window_days, 1, 365, 30);
  n.hold_days := kma_internal.program_input_int(p_input, 'hold_days', p.hold_days, 0, 90, 30);
  n.minimum_payout_minor := kma_internal.program_input_int(p_input, 'minimum_payout_minor', p.minimum_payout_minor, 0, 100000000, 2000);
  n.approval_mode := kma_internal.program_input_choice(p_input, 'approval_mode', p.approval_mode, array['automatic', 'manual'], 'automatic');
  n.extra_terms := kma_internal.program_input_text(p_input, 'extra_terms', p.extra_terms, 4000, false);

  -- A commission type keeps only its own amount, and only "months" keeps a month count.
  if n.commission_type = 'percent' then
    n.commission_fixed_minor := null;
  elsif n.commission_type = 'fixed' then
    n.commission_rate_bps := null;
  end if;
  if n.commission_duration is distinct from 'months' then
    n.commission_months := null;
  elsif n.commission_months is null then
    perform kma_internal.program_fail('invalid_commission_months', 'Say how many months commission is paid for');
  end if;
  -- A type with no amount yet is not a commission. A draft goes back to "not chosen";
  -- a published program that pays for sales must keep a full commission.
  if n.commission_type is not null and coalesce(n.commission_rate_bps, n.commission_fixed_minor) is null then
    if v_published and n.earn_from <> 'events' then
      perform kma_internal.program_fail(
        case n.commission_type when 'percent' then 'invalid_commission_rate_bps' else 'invalid_commission_fixed_minor' end,
        'Enter the commission amount');
    end if;
    n.commission_type := null;
  end if;

  -- A published program cannot lose what it was approved with, and must stay complete for
  -- what it pays for: a commission for sales, a reward and a budget for events, a product for
  -- a checkout link.
  if v_published then
    if n.name is null then perform kma_internal.program_fail('invalid_name', 'A published program needs a name'); end if;
    if n.category is null then perform kma_internal.program_fail('invalid_category', 'A published program needs a category'); end if;
    if n.tagline is null then perform kma_internal.program_fail('invalid_tagline', 'A published program needs a description'); end if;
    if n.landing_url is null then
      perform kma_internal.program_fail('invalid_landing_url', 'A published program needs a landing page');
    end if;
    if n.payment_mode = 'kma_checkout'
      and (n.checkout_name is null or n.checkout_amount_minor is null or n.checkout_success_url is null) then
      perform kma_internal.program_fail('invalid_checkout', 'A published checkout link needs a product name, a price and a page after payment');
    end if;
    if n.earn_from <> 'events' then
      if n.commission_type is null then
        perform kma_internal.program_fail('invalid_commission_type', 'A published program needs a commission');
      end if;
      if n.commission_duration is null then
        perform kma_internal.program_fail('invalid_commission_duration', 'A published program needs a commission duration');
      end if;
    end if;
    if n.earn_from <> 'sales' then
      if jsonb_array_length(n.rewards) = 0 then
        perform kma_internal.program_fail('invalid_rewards', 'A published program that pays for events needs a reward');
      end if;
      if n.reward_budget_minor is null then
        perform kma_internal.program_fail('invalid_reward_budget_minor', 'A published program that pays for events needs a monthly budget');
      end if;
    end if;
  end if;
  return n;
end $$;

-- The definition from 20261119101000_program_reward_terms.sql, with payment_mode, checkout and
-- buyer_discount_bps. A checkout-link program's landing page follows its marketplace address,
-- which follows the name until the first approval.
create or replace function public.workspace_program_save(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_fields constant text[] := array['name', 'category', 'tagline', 'logo_path', 'landing_url', 'commission_type',
    'commission_rate_bps', 'commission_fixed_minor', 'currency', 'commission_duration', 'commission_months',
    'attribution_window_days', 'hold_days', 'minimum_payout_minor', 'approval_mode', 'marketplace_listed', 'extra_terms',
    'earn_from', 'rewards', 'reward_budget_minor', 'payment_mode', 'checkout', 'buyer_discount_bps'];
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  n public.affiliate_programs;
  v_created boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k <> 'revision' and k <> all(v_fields)) then
    perform kma_internal.program_fail('invalid_input', 'The program form has fields that cannot be saved');
  end if;
  if p_input ? 'revision' and (jsonb_typeof(p_input->'revision') not in ('number', 'null')
    or (jsonb_typeof(p_input->'revision') = 'number' and p_input->>'revision' !~ '^[0-9]{1,9}$')) then
    perform kma_internal.program_fail('invalid_revision', 'revision must be a whole number');
  end if;
  v_before := kma_internal.program_for_update(p_workspace_id);
  if v_before.id is null then
    v_created := true;
    insert into public.affiliate_programs(workspace_id, slug, created_by, updated_by)
    values (p_workspace_id, kma_internal.program_slug(null, null), auth.uid(), auth.uid())
    returning * into n;
  else
    perform kma_internal.program_require_revision(v_before, (p_input->>'revision')::integer);
    if v_before.status = 'in_review' then
      perform kma_internal.program_fail('program_in_review', 'The program cannot be edited while it is in review');
    elsif v_before.status not in ('draft', 'changes_requested', 'live', 'paused') then
      perform kma_internal.program_fail('status_not_allowed', 'This program cannot be edited');
    end if;
    n := v_before;
  end if;

  n := kma_internal.program_apply_input(n, p_input);
  -- Until the first approval the marketplace address follows the name.
  if n.first_published_at is null and n.name is not null and (v_created or n.name is distinct from v_before.name) then
    n.slug := kma_internal.program_slug(n.name, n.id);
  end if;
  if n.payment_mode = 'kma_checkout' then
    n.landing_url := kma_internal.program_checkout_url(n.slug);
  end if;

  update public.affiliate_programs set
    slug = n.slug, name = n.name, category = n.category, tagline = n.tagline, logo_path = n.logo_path,
    landing_url = n.landing_url, commission_type = n.commission_type, commission_rate_bps = n.commission_rate_bps,
    commission_fixed_minor = n.commission_fixed_minor, currency = n.currency,
    commission_duration = n.commission_duration, commission_months = n.commission_months,
    attribution_window_days = n.attribution_window_days, hold_days = n.hold_days,
    minimum_payout_minor = n.minimum_payout_minor, approval_mode = n.approval_mode,
    marketplace_listed = n.marketplace_listed, extra_terms = n.extra_terms,
    earn_from = n.earn_from, rewards = n.rewards, reward_budget_minor = n.reward_budget_minor,
    payment_mode = n.payment_mode, checkout_name = n.checkout_name, checkout_amount_minor = n.checkout_amount_minor,
    checkout_interval = n.checkout_interval, checkout_success_url = n.checkout_success_url,
    buyer_discount_bps = n.buyer_discount_bps,
    revision = case when v_created then 1 else revision + 1 end,
    updated_by = auth.uid(), updated_at = v_now
  where id = n.id returning * into v_saved;

  -- The card is live at once: the product and its link destination follow it. The terms
  -- wait on the working copy until they are published.
  if v_saved.status in ('live', 'paused') then
    update public.products set name = v_saved.name
    where id = v_saved.product_id and name is distinct from v_saved.name;
    update public.funnels set destination_url = v_saved.landing_url
    where id = v_saved.funnel_id and destination_url is distinct from v_saved.landing_url;
  end if;
  perform kma_internal.program_audit(
    case when v_created then 'affiliate_program_created' else 'affiliate_program_saved' end, 'system', v_before, v_saved);
  return kma_internal.program_state(p_workspace_id, v_role);
end $$;

-- The definition from 20261114101000_affiliate_program_functions.sql, with the checkout link:
-- a checkout-link program whose Stripe account is connected but cannot take payments yet is
-- refused with stripe_charges_disabled (its product being incomplete is program_incomplete).
create or replace function public.workspace_program_submit(p_workspace_id uuid, p_revision integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_before public.affiliate_programs := kma_internal.program_for_update(p_workspace_id);
  v_saved public.affiliate_programs;
  c record;
  v_version integer;
  v_now timestamptz := clock_timestamp();
begin
  if v_before.id is null then
    perform kma_internal.program_fail('program_incomplete', 'Fill in the program before publishing it');
  end if;
  perform kma_internal.program_require_revision(v_before, p_revision);
  if v_before.status = 'in_review' then
    perform kma_internal.program_fail('program_in_review', 'The program is already in review');
  elsif v_before.status not in ('draft', 'changes_requested', 'live', 'paused') then
    perform kma_internal.program_fail('status_not_allowed', 'This program cannot be published');
  end if;
  select * into c from kma_internal.program_check(v_before);
  if not c.complete then
    perform kma_internal.program_fail('program_incomplete', 'Fill in the product, landing page and commission first');
  elsif v_before.status in ('live', 'paused') and not c.has_unpublished_changes then
    perform kma_internal.program_fail('nothing_to_publish', 'The published terms are already up to date');
  elsif not c.stripe_connected then
    if kma_internal.workspace_stripe_connection(p_workspace_id) is not null then
      perform kma_internal.program_fail('stripe_charges_disabled',
        'Your Stripe account cannot take payments yet. Finish setting it up in Stripe first');
    end if;
    perform kma_internal.program_fail('stripe_not_connected', 'Connect Stripe before publishing');
  elsif not c.agreement_read then
    perform kma_internal.program_fail('agreement_not_read', 'Read the agreement before publishing');
  end if;

  if v_before.status in ('draft', 'changes_requested') then
    update public.affiliate_programs set
      status = 'in_review', submitted_at = v_now, review_note = null,
      revision = revision + 1, updated_by = auth.uid(), updated_at = v_now
    where id = v_before.id returning * into v_saved;
    perform kma_internal.program_audit('affiliate_program_submitted', 'system', v_before, v_saved);
  else
    v_version := kma_internal.program_publish_terms(v_before, auth.uid());
    update public.affiliate_programs set
      live_terms_version = v_version,
      revision = revision + 1, updated_by = auth.uid(), updated_at = v_now
    where id = v_before.id returning * into v_saved;
    perform kma_internal.program_audit('affiliate_program_terms_published', 'system', v_before, v_saved);
  end if;
  return kma_internal.program_state(p_workspace_id, v_role);
end $$;

-- The definition from 20261114101000_affiliate_program_functions.sql, with the checkout link:
-- a checkout-link program is approved only while its Stripe account can take payments.
create or replace function public.review_admin_program(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_note text;
  v_product uuid;
  v_funnel uuid;
  v_version integer;
  v_connection jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'review affiliate programs');
  v_before := kma_internal.program_for_review(p_input, array['program_id', 'decision', 'note']);
  if jsonb_typeof(p_input->'decision') is distinct from 'string'
    or p_input->>'decision' not in ('approve', 'request_changes') then
    perform kma_internal.program_fail('invalid_decision', 'Choose approve or request_changes');
  end if;
  v_note := kma_internal.program_review_note(p_input);
  if v_before.status <> 'in_review' then
    perform kma_internal.program_fail('status_not_allowed', 'Only a program in review can be reviewed');
  end if;

  if p_input->>'decision' = 'request_changes' then
    if v_note is null then
      perform kma_internal.program_fail('invalid_note', 'Say what needs to change');
    end if;
    update public.affiliate_programs set
      status = 'changes_requested', review_note = v_note,
      reviewed_by = auth.uid(), reviewed_at = v_now,
      revision = revision + 1, updated_at = v_now
    where id = v_before.id returning * into v_saved;
    perform kma_internal.program_audit('affiliate_program_changes_requested', 'admin', v_before, v_saved, v_note);
    return jsonb_build_object('program_id', v_saved.id, 'status', v_saved.status);
  end if;

  v_connection := kma_internal.workspace_stripe_connection(v_before.workspace_id);
  if v_connection is null then
    perform kma_internal.program_fail('stripe_not_connected', 'The workspace no longer has a connected Stripe account');
  end if;
  if v_before.payment_mode = 'kma_checkout' and not coalesce((v_connection->>'charges_enabled')::boolean, false) then
    perform kma_internal.program_fail('stripe_charges_disabled', 'The workspace''s Stripe account cannot take payments yet');
  end if;
  -- The brand comes from the Stripe account, which can change while a listing waits.
  if not (select c.agreement_read from kma_internal.program_check(v_before) c) then
    perform kma_internal.program_fail('agreement_not_read',
      'The agreement changed after the merchant read it. Request changes so they read it again');
  end if;
  insert into public.products(name, slug, status, tracking_mode)
  values (v_before.name, kma_internal.program_product_slug(v_before.slug), 'active', 'commercial')
  returning id into v_product;
  insert into public.funnels(product_id, key, name, destination_url, status, is_default)
  values (v_product, 'main', 'Main', v_before.landing_url, 'live', true)
  returning id into v_funnel;
  -- Version 1 is what the merchant sent for review, in their name.
  v_version := kma_internal.program_publish_terms(v_before, coalesce(v_before.updated_by, v_before.created_by));
  update public.affiliate_programs set
    status = 'live', product_id = v_product, funnel_id = v_funnel, review_note = null,
    live_terms_version = v_version,
    first_published_at = v_now, reviewed_by = auth.uid(), reviewed_at = v_now,
    revision = revision + 1, updated_at = v_now
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit('affiliate_program_approved', 'admin', v_before, v_saved, v_note);
  return jsonb_build_object('program_id', v_saved.id, 'status', v_saved.status);
end $$;

-- kma_internal.program_review_json (the admin review) is program_json and more, so it shows
-- the payment mode, the product and the discount without being written again.

-- What creators and the marketplace read -------------------------------------------------------

-- The definition from 20261119101000_program_reward_terms.sql, with how buyers pay, from the
-- published terms: payment_mode, checkout ({name, amount_minor, interval} of a checkout-link
-- program, else null) and buyer_discount_bps (null when buyers get no discount). The
-- marketplace, a program's detail and every membership read this card.
create or replace function kma_internal.program_card(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'slug', p.slug, 'name', p.name, 'category', p.category, 'tagline', p.tagline, 'logo_path', p.logo_path,
    'brand_name', coalesce(t.terms->>'brand_name', p.name),
    'commission_type', t.terms->'commission_type', 'commission_rate_bps', t.terms->'commission_rate_bps',
    'commission_fixed_minor', t.terms->'commission_fixed_minor', 'currency', t.terms->'currency',
    'commission_duration', t.terms->'commission_duration', 'commission_months', t.terms->'commission_months',
    'attribution_window_days', t.terms->'attribution_window_days', 'hold_days', t.terms->'hold_days',
    'minimum_payout_minor', t.terms->'minimum_payout_minor',
    'approval_mode', t.terms->'approval_mode', 'terms_version', t.version,
    'earn_from', kma_internal.program_terms_earn_from(t.terms),
    'rewards', kma_internal.program_terms_rewards(t.terms))
    || jsonb_build_object(
    'payment_mode', kma_internal.program_terms_payment_mode(t.terms),
    'checkout', kma_internal.program_terms_checkout(t.terms),
    'buyer_discount_bps', kma_internal.program_terms_discount(t.terms))
  from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version
$$;

-- The definition from 20261115101000_program_join.sql, with the member's promo code
-- (kma_internal.program_promo_code_json): what partner_program_detail, partner_marketplace and
-- the creator's join, accept and leave answers say about their own membership.
create or replace function kma_internal.program_membership_json(m public.affiliate_program_members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'program_id', p.id, 'program', kma_internal.program_card(p), 'program_status', p.status,
    'status', m.status, 'terms_version', m.terms_version,
    'accepted_at', (select a.accepted_at from public.affiliate_program_acceptances a
      where a.member_id = m.id and a.terms_version = m.terms_version),
    'needs_new_terms', m.terms_version < p.live_terms_version,
    'link', (select jsonb_build_object(
        'url', l.tracking_url,
        'short_url', (select 'https://go.kissmyapps.dev' || a.path from kma_internal.tracking_link_aliases a where a.link_id = l.id),
        'working', m.status = 'active' and p.status = 'live' and l.status = 'active')
      from public.affiliate_links l where l.id = m.main_link_id),
    'requested_at', m.requested_at, 'activated_at', m.activated_at, 'ended_at', m.ended_at,
    'decision_note', m.decision_note,
    'promo_code', kma_internal.program_promo_code_json(m.program_id, m.id))
  from public.affiliate_programs p where p.id = m.program_id
$$;

-- The definition from 20261119103000_program_reward_numbers.sql, with the creator's promo code.
create or replace function kma_internal.program_links_json(p public.affiliate_programs, p_affiliate uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_zone text := kma_internal.program_link_timezone(p_affiliate);
  v_today date := (now() at time zone v_zone)::date;
  v_from timestamptz := (v_today - 29)::timestamp at time zone v_zone;
  v_to timestamptz := (v_today + 1)::timestamp at time zone v_zone;
  v_working boolean;
begin
  v_working := kma_internal.program_links_live(p) and exists (
    select 1 from public.affiliate_program_members m
    join public.affiliate_links l on l.id = m.main_link_id and l.status = 'active'
    where m.program_id = p.id and m.affiliate_id = p_affiliate and m.status = 'active');
  return (
    select jsonb_build_object(
      'program_id', p.id, 'slug', p.slug, 'name', p.name, 'currency', kma_internal.program_link_currency(p),
      'earn_from', kma_internal.program_link_earn_from(p),
      'working', v_working,
      'paused_reason', case when v_working then null
        when p.status = 'paused' and p.pause_reason = 'balance_empty' then 'balance_empty'
        else 'program_paused' end,
      'promo_code', (select kma_internal.program_promo_code_json(p.id, m.id) from public.affiliate_program_members m
        where m.program_id = p.id and m.affiliate_id = p_affiliate),
      'custom_links', count(*) filter (where r.kind = 'custom'),
      'links', coalesce(jsonb_agg(jsonb_build_object(
          'link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name, 'url', r.url,
          'created_at', r.created_at,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'events', coalesce(t.events, 0),
          'earnings_minor', coalesce(t.earnings_minor, 0),
          'removable', r.kind = 'custom'
            and not exists (select 1 from public.clicks k where k.affiliate_link_id = r.link_id))
        order by r.place), '[]'::jsonb))
    from kma_internal.program_link_rows(p.id, p_affiliate) r
    left join kma_internal.program_link_stats(p.id, p_affiliate, v_from, v_to) t on t.link_id = r.link_id
    where r.status <> 'archived');
end $$;

-- Promo codes ----------------------------------------------------------------------------------

-- The text of a creator's code: their public name, else their handle, in capital letters and
-- digits only, at most 12 of them, then the discount in whole percent: ANNA10. When another
-- code on the same Stripe account has that text (one that is not retired, or a retired one
-- that is not yet switched off on Stripe), a digit follows: ANNA102, ANNA103 ... p_after is a
-- text Stripe already refused (code_taken): the next one after it is chosen. Never a buyer's
-- or a person's data.
create function kma_internal.program_promo_code_text(p_affiliate uuid, p_discount integer, p_account text,
  p_after text default null) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_name text;
  v_handle text;
  v_base text;
  v_percent text := (p_discount / 100)::text;
  v_code text;
  v_n integer := 1;
begin
  perform pg_advisory_xact_lock(hashtextextended('program-promo-code:' || p_account, 0));
  select upper(regexp_replace(coalesce(a.public_name, ''), '[^A-Za-z0-9]+', '', 'g')),
      upper(regexp_replace(coalesce(a.slug, ''), '[^A-Za-z0-9]+', '', 'g'))
    into v_name, v_handle
    from public.affiliates a where a.id = p_affiliate;
  v_base := left(case when length(v_name) >= 3 then v_name when length(v_handle) >= 3 then v_handle else 'CREATOR' end, 12);
  if p_after = v_base || v_percent then
    v_n := 2;
  elsif p_after ~ ('^' || v_base || v_percent || '[0-9]{1,3}$') then
    v_n := substr(p_after, length(v_base || v_percent) + 1)::integer + 1;
  end if;
  loop
    v_code := v_base || v_percent || case when v_n > 1 then v_n::text else '' end;
    exit when not exists (select 1 from public.program_promo_codes c
      where c.account_id = p_account and c.code = v_code
        and (c.status <> 'retired' or (c.stripe_promotion_code_id is not null and c.deactivated_at is null)));
    v_n := v_n + 1;
  end loop;
  return v_code;
end $$;

-- Makes a program's codes what its published terms say, for every member or for one:
--   - a code is retired when its creator is no longer an active member, when the published
--     discount is gone or is another one, or when the program's Stripe account is another one;
--   - an active member with no code gets a pending one while the published terms give a
--     discount and the workspace has a connected Stripe account.
-- While Stripe is disconnected nothing is retired for that reason and nothing new is issued.
-- A retired code that was made on Stripe waits to be switched off there by the worker.
create function kma_internal.program_promo_sync(p_program uuid, p_member uuid default null) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  p public.affiliate_programs;
  m record;
  v_discount integer;
  v_account text;
  v_now timestamptz := clock_timestamp();
  v_issued integer := 0;
begin
  select * into p from public.affiliate_programs where id = p_program;
  if p.id is null then
    return 0;
  end if;
  if p.status in ('live', 'paused') then
    select kma_internal.program_terms_discount(t.terms) into v_discount
    from public.affiliate_program_terms t where t.program_id = p.id and t.version = p.live_terms_version;
  end if;
  v_account := kma_internal.workspace_stripe_connection(p.workspace_id)->>'account_id';

  update public.program_promo_codes c set status = 'retired', retired_at = v_now, next_attempt_at = v_now
  where c.program_id = p.id and c.status <> 'retired' and (p_member is null or c.member_id = p_member)
    and (v_discount is null or c.discount_bps <> v_discount
      or (v_account is not null and c.account_id <> v_account)
      or not exists (select 1 from public.affiliate_program_members x where x.id = c.member_id and x.status = 'active'));

  if v_discount is null or v_account is null then
    return 0;
  end if;
  for m in
    select x.id, x.affiliate_id from public.affiliate_program_members x
    where x.program_id = p.id and x.status = 'active' and (p_member is null or x.id = p_member)
      and not exists (select 1 from public.program_promo_codes c
        where c.program_id = p.id and c.member_id = x.id and c.status <> 'retired')
    order by x.activated_at, x.id
  loop
    insert into public.program_promo_codes(program_id, member_id, code, account_id, discount_bps, created_at, next_attempt_at)
    values (p.id, m.id, kma_internal.program_promo_code_text(m.affiliate_id, v_discount, v_account), v_account, v_discount,
      v_now, v_now);
    v_issued := v_issued + 1;
  end loop;
  return v_issued;
end $$;

-- A member who becomes active gets a code; one who stops being active has it retired. A
-- program whose published terms change (or that is archived) has its codes brought in line.
-- Codes come second to what set the trigger off: a failure here is a warning, and the next
-- claim of the worker makes up for it.
create function kma_internal.program_promo_on_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform kma_internal.program_promo_sync(new.program_id, new.id);
  exception when others then
    raise warning 'The promo code of program member % was not brought in line: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger affiliate_program_members_promo_insert
  after insert on public.affiliate_program_members
  for each row when (new.status = 'active') execute function kma_internal.program_promo_on_member();
create trigger affiliate_program_members_promo_update
  after update of status on public.affiliate_program_members
  for each row when (new.status is distinct from old.status and 'active' in (new.status, old.status))
  execute function kma_internal.program_promo_on_member();

create function kma_internal.program_promo_on_program() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform kma_internal.program_promo_sync(new.id);
  exception when others then
    raise warning 'The promo codes of program % were not brought in line: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger affiliate_programs_promo_codes
  after update of live_terms_version, status on public.affiliate_programs
  for each row when (new.live_terms_version is distinct from old.live_terms_version or new.status is distinct from old.status)
  execute function kma_internal.program_promo_on_program();

-- The programs whose codes are out of line with their published terms: an active member with
-- no code while the terms give a discount, or a code that is not retired and should be.
create function kma_internal.program_promo_out_of_line() returns table (program_id uuid)
language sql stable set search_path = '' as $$
  select p.id from public.affiliate_programs p
  left join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
  where (p.status in ('live', 'paused') and kma_internal.program_terms_discount(t.terms) is not null
      and exists (select 1 from public.affiliate_program_members m
        where m.program_id = p.id and m.status = 'active'
          and not exists (select 1 from public.program_promo_codes c
            where c.program_id = p.id and c.member_id = m.id and c.status <> 'retired')))
    or exists (select 1 from public.program_promo_codes c
      join public.affiliate_program_members m on m.id = c.member_id
      where c.program_id = p.id and c.status <> 'retired'
        and (m.status <> 'active' or p.status not in ('live', 'paused')
          or c.discount_bps is distinct from kma_internal.program_terms_discount(t.terms)))
  order by p.id
  limit 20
$$;

-- The worker's batch. First brings out-of-line programs in line, then leases, oldest first:
--   codes: pending codes to make on Stripe, {id, code, account_id, discount_bps, coupon_id,
--     program_id}. coupon_id is the coupon a finished code of the same program, account and
--     discount already has (reuse it), else null (make one). Of the codes that would need a
--     new coupon, only one per program and discount is handed out at a time, so one coupon
--     is made for each.
--   deactivate: retired codes still live on Stripe, {id, account_id, promotion_code_id}.
-- Only codes whose Stripe account is the active connection of their program's workspace.
-- Input: {limit 1..50 (default 10), lease_seconds 30..900 (default 600)}; each list holds
-- up to limit codes. A code claimed and not finished within its lease is handed out again.
-- A switch-off that keeps failing is offered again for as long as it takes (see
-- finish_program_promo_code), never given up.
create function public.claim_program_promo_codes(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_limit integer;
  v_lease integer;
  v_now timestamptz := clock_timestamp();
  v_program uuid;
  v_codes jsonb;
  v_deactivate jsonb;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k not in ('limit', 'lease_seconds'))
    or (p_input ? 'limit' and (jsonb_typeof(p_input->'limit') <> 'number' or p_input->>'limit' !~ '^[0-9]{1,2}$'))
    or (p_input ? 'lease_seconds' and (jsonb_typeof(p_input->'lease_seconds') <> 'number' or p_input->>'lease_seconds' !~ '^[0-9]{1,3}$'))
  then
    raise exception 'Invalid claim' using errcode = '22023';
  end if;
  v_limit := coalesce((p_input->>'limit')::integer, 10);
  v_lease := coalesce((p_input->>'lease_seconds')::integer, 600);
  if v_limit not between 1 and 50 or v_lease not between 30 and 900 then
    raise exception 'Invalid claim' using errcode = '22023';
  end if;
  -- One claim at a time: the one-coupon rule looks at the codes other claims hold.
  perform pg_advisory_xact_lock(hashtextextended('program-promo-claim', 0));

  for v_program in select o.program_id from kma_internal.program_promo_out_of_line() o loop
    begin
      perform kma_internal.program_promo_sync(v_program);
    exception when others then
      raise warning 'The promo codes of program % were not brought in line: %', v_program, sqlerrm;
    end;
  end loop;

  with connected as (
    select c.id, c.program_id, c.account_id, c.discount_bps, c.created_at,
      (select x.stripe_coupon_id from public.program_promo_codes x
        where x.program_id = c.program_id and x.account_id = c.account_id and x.discount_bps = c.discount_bps
          and x.stripe_coupon_id is not null
        order by x.activated_at nulls last, x.created_at, x.id limit 1) as coupon_id
    from public.program_promo_codes c
    join public.affiliate_programs g on g.id = c.program_id
    join public.merchant_businesses b on b.workspace_id = g.workspace_id
    join public.merchant_connections mc on mc.merchant_id = b.id and mc.livemode and mc.status = 'active'
      and mc.account_id = c.account_id
    where c.status = 'pending' and c.attempts < 5 and c.next_attempt_at <= v_now
      and (c.lease_until is null or c.lease_until < v_now)
  ), ranked as (
    select k.*, row_number() over (partition by k.program_id, k.account_id, k.discount_bps
      order by k.created_at, k.id) as place
    from connected k
  ), picked as (
    select r.id, r.coupon_id from ranked r
    where r.coupon_id is not null
      or (r.place = 1 and not exists (select 1 from public.program_promo_codes x
        where x.program_id = r.program_id and x.account_id = r.account_id and x.discount_bps = r.discount_bps
          and x.status = 'pending' and x.lease_until >= v_now))
    order by r.created_at, r.id
    limit v_limit
  ), leased as (
    update public.program_promo_codes c set lease_until = v_now + make_interval(secs => v_lease)
    from picked where c.id = picked.id
    returning c.id, c.code, c.account_id, c.discount_bps, picked.coupon_id, c.program_id, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'account_id', l.account_id,
      'discount_bps', l.discount_bps, 'coupon_id', l.coupon_id, 'program_id', l.program_id)
      order by l.created_at, l.id), '[]'::jsonb)
    into v_codes from leased l;

  with picked as (
    select c.id from public.program_promo_codes c
    join public.affiliate_programs g on g.id = c.program_id
    join public.merchant_businesses b on b.workspace_id = g.workspace_id
    join public.merchant_connections mc on mc.merchant_id = b.id and mc.livemode and mc.status = 'active'
      and mc.account_id = c.account_id
    where c.status = 'retired' and c.stripe_promotion_code_id is not null and c.deactivated_at is null
      and c.next_attempt_at <= v_now and (c.lease_until is null or c.lease_until < v_now)
    order by c.retired_at, c.id
    limit v_limit
  ), leased as (
    update public.program_promo_codes c set lease_until = v_now + make_interval(secs => v_lease)
    from picked where c.id = picked.id
    returning c.id, c.account_id, c.stripe_promotion_code_id, c.retired_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'account_id', l.account_id,
      'promotion_code_id', l.stripe_promotion_code_id) order by l.retired_at, l.id), '[]'::jsonb)
    into v_deactivate from leased l;

  return jsonb_build_object('codes', v_codes, 'deactivate', v_deactivate);
end $$;

-- What the worker did with one code it claimed. One of:
--   {id, coupon_id, promotion_code_id}: made on Stripe. A pending (or failed) code becomes
--     active; a code retired meanwhile keeps the ids and waits to be switched off.
--   {id, error, coupon_id?}: Stripe refused. error is a short code (code_taken when the text
--     is taken on the merchant's account: the code gets the next text and is tried again at
--     once). Otherwise it is tried again later (2, 4, 8 ... minutes); the fifth failure makes
--     it failed, with error kept as last_error. A coupon made before the refusal is kept for
--     reuse. For a retired code being switched off (one from the deactivate list), the code
--     stays retired and is offered again after the same backoff (at most 6 hours), with no
--     limit on tries, until it is reported deactivated.
--   {id, deactivated: true}: a retired code is switched off on Stripe.
-- Answer: {id, code, status, attempts}. Raises 22023 for a malformed call, P0002 for an
-- unknown code, 55000 for a call that does not fit the code's state.
create function public.finish_program_promo_code(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.program_promo_codes;
  v_id uuid;
  v_error text;
  v_now timestamptz := clock_timestamp();
  v_affiliate uuid;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k not in ('id', 'coupon_id', 'promotion_code_id', 'error', 'deactivated'))
    or jsonb_typeof(p_input->'id') is distinct from 'string'
    or (p_input ? 'coupon_id' and (jsonb_typeof(p_input->'coupon_id') <> 'string' or length(p_input->>'coupon_id') not between 1 and 200
      or p_input->>'coupon_id' ~ '[[:space:][:cntrl:]]'))
    or (p_input ? 'promotion_code_id' and (jsonb_typeof(p_input->'promotion_code_id') <> 'string'
      or p_input->>'promotion_code_id' !~ '^promo_[A-Za-z0-9]{1,250}$'))
    or (p_input ? 'error' and (jsonb_typeof(p_input->'error') <> 'string' or p_input->>'error' !~ '^[a-z][a-z0-9_]{1,59}$'))
    or (p_input ? 'deactivated' and p_input->'deactivated' is distinct from 'true'::jsonb)
    -- Exactly one outcome.
    or ((p_input ? 'promotion_code_id')::integer + (p_input ? 'error')::integer + (p_input ? 'deactivated')::integer) <> 1
    or (p_input ? 'promotion_code_id' and not p_input ? 'coupon_id')
    or (p_input ? 'deactivated' and p_input ? 'coupon_id')
  then
    raise exception 'Invalid promo code outcome' using errcode = '22023';
  end if;
  v_id := kma_internal.workspace_stripe_uuid(p_input->>'id');
  if v_id is null then
    raise exception 'Invalid promo code outcome' using errcode = '22023';
  end if;
  select * into c from public.program_promo_codes where id = v_id for update;
  if c.id is null then
    raise exception 'Promo code not found' using errcode = 'P0002';
  end if;
  v_error := p_input->>'error';

  if p_input ? 'promotion_code_id' then
    if c.stripe_promotion_code_id is not null then
      if c.stripe_promotion_code_id <> p_input->>'promotion_code_id' then
        raise exception 'This code was already made on Stripe' using errcode = '55000';
      end if;
    elsif c.status = 'retired' then
      update public.program_promo_codes set stripe_coupon_id = p_input->>'coupon_id',
        stripe_promotion_code_id = p_input->>'promotion_code_id', lease_until = null, next_attempt_at = v_now, last_error = null
      where id = c.id returning * into c;
    else
      update public.program_promo_codes set status = 'active', stripe_coupon_id = p_input->>'coupon_id',
        stripe_promotion_code_id = p_input->>'promotion_code_id', activated_at = v_now, lease_until = null, last_error = null
      where id = c.id returning * into c;
    end if;
  elsif p_input ? 'deactivated' then
    if c.status <> 'retired' or c.stripe_promotion_code_id is null then
      raise exception 'Only a retired code made on Stripe can be switched off' using errcode = '55000';
    end if;
    update public.program_promo_codes set deactivated_at = coalesce(deactivated_at, v_now), lease_until = null
    where id = c.id returning * into c;
  elsif c.status = 'retired' then
    -- Switching off failed; a code that was never made on Stripe has nothing to switch off.
    if c.stripe_promotion_code_id is not null and c.deactivated_at is null then
      update public.program_promo_codes set deactivate_attempts = deactivate_attempts + 1, last_error = v_error,
        lease_until = null,
        next_attempt_at = v_now + make_interval(mins => least(360, power(2, least(deactivate_attempts + 1, 9)))::integer)
      where id = c.id returning * into c;
    else
      update public.program_promo_codes set lease_until = null where id = c.id returning * into c;
    end if;
  elsif c.status in ('pending', 'failed') then
    if v_error = 'code_taken' and c.attempts + 1 < 5 then
      select m.affiliate_id into v_affiliate from public.affiliate_program_members m where m.id = c.member_id;
      update public.program_promo_codes set attempts = attempts + 1, last_error = v_error, lease_until = null,
        code = kma_internal.program_promo_code_text(v_affiliate, c.discount_bps, c.account_id, c.code),
        stripe_coupon_id = coalesce(p_input->>'coupon_id', stripe_coupon_id), next_attempt_at = v_now
      where id = c.id returning * into c;
    else
      update public.program_promo_codes set attempts = attempts + 1, last_error = v_error, lease_until = null,
        status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
        stripe_coupon_id = coalesce(p_input->>'coupon_id', stripe_coupon_id),
        next_attempt_at = v_now + make_interval(mins => least(360, power(2, attempts + 1)::integer))
      where id = c.id returning * into c;
    end if;
  else
    raise exception 'This code is already active' using errcode = '55000';
  end if;
  return jsonb_build_object('id', c.id, 'code', c.code, 'status', c.status, 'attempts', c.attempts);
end $$;

-- Sales paid with a code -----------------------------------------------------------------------

-- The click a sale paid with a creator's code is tied to: one click on the creator's main
-- link at the moment the sale was paid, made once per sale and marked as a code use. Read by
-- record_program_sale only. Returns the click's id and public id.
create function kma_internal.program_promo_code_click(p_code public.program_promo_codes, p_sale public.program_sales,
  out click_record_id uuid, out click_id text)
language plpgsql volatile set search_path = '' as $$
declare
  v_member public.affiliate_program_members;
  v_link public.affiliate_links;
  v_destination text;
begin
  select k.id, k.public_click_id into click_record_id, click_id
  from public.program_promo_code_uses u
  join public.clicks k on k.id = u.click_record_id
  where u.sale_id = p_sale.id;
  if click_record_id is not null then
    return;
  end if;
  select * into v_member from public.affiliate_program_members where id = p_code.member_id;
  select * into v_link from public.affiliate_links where id = v_member.main_link_id;
  if v_link.id is null then
    return;
  end if;
  select coalesce(f.destination_url, g.landing_url) into v_destination
  from public.affiliate_programs g left join public.funnels f on f.id = v_link.funnel_id
  where g.id = p_code.program_id;
  click_id := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.clicks(public_click_id, affiliate_link_id, affiliate_id, product_id, source_id, campaign_id,
    funnel_id, sub1, sub2, sub3, destination_url_snapshot, is_bot, commercial_eligible, occurred_at)
  values (click_id, v_link.id, v_link.affiliate_id, v_link.product_id, v_link.source_id, v_link.campaign_id,
    v_link.funnel_id, v_link.sub1, v_link.sub2, v_link.sub3, v_destination, false, v_link.commercial_eligible, p_sale.paid_at)
  returning id into click_record_id;
  insert into public.program_promo_code_uses(click_record_id, code_id, sale_id)
  values (click_record_id, p_code.id, p_sale.id)
  on conflict (sale_id) do nothing;
end $$;

-- The definition from 20261114110000_program_sales.sql, with promo codes. The input may name
-- promotion_code_id, the Stripe promotion code the buyer used (promo_...). It is kept on the
-- sale whatever it is. When it is a creator code of the program that was live when the buyer
-- paid, the sale goes to that creator (match_source promotion_code), ahead of the creator tag,
-- the subscription and the buyer's profile. A renewal that carries no code of its own follows
-- the first sale of its subscription as before.
create or replace function public.record_program_sale(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.merchant_payment_events;
  v_program public.affiliate_programs;
  v_sale public.program_sales;
  v_intent text := p_input->>'payment_intent_id';
  v_charge text := p_input->>'charge_id';
  v_session text := p_input->>'checkout_session_id';
  v_invoice text := p_input->>'invoice_id';
  v_subscription text := p_input->>'subscription_id';
  v_customer text := p_input->>'customer_id';
  v_reason text := p_input->>'billing_reason';
  v_currency text := upper(p_input->>'currency');
  v_fee_currency text := upper(p_input->>'fee_currency');
  v_email text := lower(btrim(p_input->>'buyer_email'));
  v_promo text := p_input->>'promotion_code_id';
  v_code public.program_promo_codes;
  v_use record;
  v_amount bigint;
  v_tax bigint;
  v_fee bigint;
  v_refunded bigint;
  v_paid_at timestamptz;
  v_tag text;
  v_tag_source text;
  v_window integer;
  v_created boolean;
  v_email_allowed boolean;
  v_id uuid;
  v_click record;
begin
  v_receipt := kma_internal.program_sale_leased_receipt(p_input);
  -- One sale at a time per merchant account: recording a sale can renumber and re-match
  -- the other sales of its subscription.
  perform pg_advisory_xact_lock(hashtextextended('kma-program-sale:' || v_receipt.account_id, 0));
  if v_receipt.event_type not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
      'payment_intent.succeeded', 'invoice.paid')
    or p_input->'livemode' is distinct from 'true'::jsonb
    or coalesce(v_intent, '') !~ '^pi_[A-Za-z0-9_]{1,252}$'
    or (v_receipt.payment_intent_id is not null and v_receipt.payment_intent_id <> v_intent)
    or coalesce(v_charge, '') !~ '^[a-z]{2,4}_[A-Za-z0-9_]{1,250}$'
    or (v_session is not null and v_session !~ '^cs_[A-Za-z0-9_]{1,252}$')
    or (v_invoice is not null and v_invoice !~ '^in_[A-Za-z0-9_]{1,252}$')
    or (v_subscription is not null and v_subscription !~ '^sub_[A-Za-z0-9_]{1,251}$')
    or (v_customer is not null and v_customer !~ '^cus_[A-Za-z0-9_]{1,251}$')
    or (v_reason is not null and v_reason !~ '^[a-z_]{1,60}$')
    or coalesce(v_currency, '') !~ '^[A-Z]{3}$'
    or not kma_internal.program_sale_amount_ok(p_input, 'amount_minor', true)
    or not kma_internal.program_sale_amount_ok(p_input, 'tax_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'fee_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'refunded_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'paid_at', true)
    or ((p_input->>'fee_minor') is null) <> (v_fee_currency is null)
    or (v_fee_currency is not null and v_fee_currency !~ '^[A-Z]{3}$')
    or (p_input ? 'kma_click' and jsonb_typeof(p_input->'kma_click') not in ('string', 'null'))
    or ((p_input->>'kma_click') is not null and coalesce(p_input->>'tag_source', '') not in ('metadata', 'client_reference_id'))
    or (p_input ? 'buyer_email' and jsonb_typeof(p_input->'buyer_email') not in ('string', 'null'))
    or (p_input ? 'promotion_code_id' and jsonb_typeof(p_input->'promotion_code_id') not in ('string', 'null'))
    or (v_promo is not null and v_promo !~ '^promo_[A-Za-z0-9]{1,250}$')
  then
    raise exception 'Invalid program sale' using errcode = '22023';
  end if;
  v_amount := (p_input->>'amount_minor')::bigint;
  v_tax := (p_input->>'tax_minor')::bigint;
  v_fee := (p_input->>'fee_minor')::bigint;
  v_refunded := (p_input->>'refunded_minor')::bigint;
  v_paid_at := to_timestamp((p_input->>'paid_at')::bigint);
  if v_amount <= 0 or (p_input->>'paid_at')::bigint <= 0 or v_paid_at > clock_timestamp() + interval '10 minutes' then
    raise exception 'Invalid program sale' using errcode = '22023';
  end if;
  -- Anything that is not an email address is ignored, not refused.
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    v_email := null;
  end if;
  -- The tag the worker read from Stripe, else the one the signed event carried.
  v_tag := kma_internal.program_sale_clean_tag(p_input->>'kma_click', p_input->>'tag_source');
  v_tag_source := p_input->>'tag_source';
  if v_tag is null then
    v_tag := kma_internal.program_sale_clean_tag(v_receipt.kma_click, v_receipt.tag_source);
    v_tag_source := v_receipt.tag_source;
  end if;

  select * into v_program from kma_internal.program_sale_program(v_receipt.connection_id, v_receipt.account_id);
  if v_program.id is null then
    return jsonb_build_object('recorded', false, 'reason', 'no_program');
  end if;
  -- The window creators agreed to: the published terms, not an unpublished edit.
  v_window := coalesce((select (t.terms->>'attribution_window_days')::integer
    from public.affiliate_program_terms t
    where t.program_id = v_program.id and t.version = v_program.live_terms_version
      and (t.terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'), v_program.attribution_window_days);

  insert into public.program_sales(program_id, connection_id, account_id, payment_intent_id, charge_id,
      amount_minor, currency, paid_at)
    values (v_program.id, v_receipt.connection_id, v_receipt.account_id, v_intent, v_charge,
      v_amount, v_currency, v_paid_at)
    on conflict (account_id, payment_intent_id) do nothing
    returning id into v_id;
  v_created := v_id is not null;
  select * into v_sale from public.program_sales s
    where s.account_id = v_receipt.account_id and s.payment_intent_id = v_intent
    for update;
  -- Stripe never changes what a succeeded payment received.
  if v_sale.amount_minor <> v_amount or v_sale.currency <> v_currency then
    return jsonb_build_object('recorded', false, 'reason', 'sale_conflict');
  end if;

  update public.program_sales s set
      charge_id = coalesce(v_charge, s.charge_id),
      checkout_session_id = coalesce(s.checkout_session_id, v_session),
      invoice_id = coalesce(s.invoice_id, v_invoice),
      subscription_id = coalesce(s.subscription_id, v_subscription),
      subscription_sequence = case when coalesce(s.subscription_id, v_subscription) is null then null
        else coalesce(s.subscription_sequence, 1) end,
      customer_id = coalesce(s.customer_id, v_customer),
      billing_reason = coalesce(s.billing_reason, v_reason),
      tax_minor = coalesce(v_tax, s.tax_minor),
      fee_minor = coalesce(v_fee, s.fee_minor),
      fee_currency = case when v_fee is null then s.fee_currency else v_fee_currency end,
      refunded_minor = coalesce(v_refunded, s.refunded_minor),
      promotion_code_id = coalesce(s.promotion_code_id, v_promo),
      verified_at = clock_timestamp()
    where s.id = v_sale.id
    returning * into v_sale;

  -- Matching, in order: the creator's promo code the buyer paid with, the creator tag, the
  -- first sale of the subscription, the buyer's identified profile. A renewal is never
  -- matched by email: its buyer subscribed before.
  v_email_allowed := v_sale.billing_reason is null or v_sale.billing_reason in ('subscription_create', 'manual');
  if v_sale.match_source = 'email' and not v_email_allowed then
    update public.program_sales s
      set click_id = null, click_record_id = null, affiliate_id = null, match_source = 'none'
      where s.id = v_sale.id returning * into v_sale;
  end if;
  -- A code counts when it is one of this program's creator codes and was live when the buyer
  -- paid: active now, or retired after the payment. The sale is tied to a click on that
  -- creator's main link, made for it (kma_internal.program_promo_code_click).
  if v_sale.promotion_code_id is not null then
    select c.* into v_code from public.program_promo_codes c
      where c.account_id = v_sale.account_id and c.stripe_promotion_code_id = v_sale.promotion_code_id
        and c.program_id = v_program.id
        and (c.status = 'active' or (c.status = 'retired' and c.retired_at > v_sale.paid_at));
    if v_code.id is not null then
      select * into v_use from kma_internal.program_promo_code_click(v_code, v_sale);
      if v_use.click_record_id is not null
        and (v_sale.match_source <> 'promotion_code' or v_sale.click_record_id is distinct from v_use.click_record_id) then
        update public.program_sales s
          set click_id = v_use.click_id, click_record_id = v_use.click_record_id,
            affiliate_id = (select k.affiliate_id from public.clicks k where k.id = v_use.click_record_id),
            match_source = 'promotion_code'
          where s.id = v_sale.id returning * into v_sale;
      end if;
    end if;
  end if;
  if v_tag is not null and v_sale.match_source <> 'promotion_code'
    and not (v_sale.match_source in ('metadata', 'client_reference_id') and v_sale.click_record_id is not null) then
    select * into v_click from kma_internal.program_sale_click(v_program.product_id, v_tag);
    if v_click.click_record_id is not null then
      update public.program_sales s
        set click_id = v_tag, click_record_id = v_click.click_record_id, affiliate_id = v_click.affiliate_id,
          match_source = v_tag_source
        where s.id = v_sale.id returning * into v_sale;
    elsif v_sale.match_source = 'none' then
      -- A tag that names no click of this product is kept, unmatched, so it can be explained.
      update public.program_sales s set click_id = v_tag, match_source = v_tag_source
        where s.id = v_sale.id returning * into v_sale;
    end if;
  end if;
  if v_sale.subscription_id is not null then
    perform kma_internal.program_sale_resequence(v_sale.account_id, v_sale.subscription_id);
    select * into v_sale from public.program_sales s where s.id = v_sale.id;
  end if;
  if v_sale.click_record_id is null and v_email is not null and v_email_allowed
    and coalesce(v_sale.subscription_sequence, 1) = 1 then
    select * into v_click from kma_internal.program_sale_email_click(
      v_program.workspace_id, v_program.product_id, v_email, v_sale.paid_at, v_window);
    if v_click.click_record_id is not null then
      update public.program_sales s
        set click_id = v_click.click_id, click_record_id = v_click.click_record_id,
          affiliate_id = v_click.affiliate_id, match_source = 'email'
        where s.id = v_sale.id returning * into v_sale;
      if v_sale.subscription_id is not null then
        perform kma_internal.program_sale_resequence(v_sale.account_id, v_sale.subscription_id);
      end if;
    end if;
  end if;

  return jsonb_build_object('recorded', true, 'created', v_created, 'sale_id', v_sale.id,
    'status', kma_internal.program_sale_refresh_status(v_sale.id),
    'match_source', v_sale.match_source, 'matched', v_sale.click_record_id is not null,
    'fee_known', v_sale.fee_minor is not null);
end $$;

-- The checkout link ----------------------------------------------------------------------------

-- What the program-checkout edge function sells for one visit to
-- https://kissmyapps.dev/checkout/<program>. Input: {program: the marketplace address (slug),
-- click: the kma_click of the visit, or null}. Answer:
--   {ok: true, program_name, account_id (the merchant's Stripe account), currency,
--    product: {name, amount_minor, interval}, success_url, cancel_url, click, promotion_code_id,
--    buyer_discount_bps}
-- where click is the visit's click when it is a real click on the program's product (else
-- null), promotion_code_id is that click's creator's active code (else null), and
-- buyer_discount_bps is the discount the published terms give (null: none, so the checkout
-- takes no codes). The product and the page after payment are the merchant's working copy,
-- like the landing page of any program; cancel_url is the home page of the site the page after
-- payment is on (the program's product site). Or {ok: false, reason}: not_found (no checkout-link
-- program has that address), not_live (not published yet, or program money is off), paused,
-- no_connection (no connected Stripe account that can take payments).
create function public.program_checkout_target(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.affiliate_programs;
  v_key text;
  v_click text;
  v_connection jsonb;
  v_found record;
  v_promo text;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k not in ('program', 'click')) then
    raise exception 'Invalid checkout request' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input->'program') = 'string' and p_input->>'program' ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    and length(p_input->>'program') between 2 and 80 then
    v_key := p_input->>'program';
  end if;
  -- The click comes from the address the visitor opened: anything that is not a click id is
  -- treated as no click.
  if jsonb_typeof(p_input->'click') = 'string' and p_input->>'click' ~ '^[A-Za-z0-9_-]{16,128}$' then
    v_click := p_input->>'click';
  end if;

  select * into g from public.affiliate_programs where slug = v_key and status <> 'archived';
  if g.id is null or g.payment_mode <> 'kma_checkout' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if g.status not in ('live', 'paused') or not kma_internal.program_money_enabled() then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;
  if g.status = 'paused' then
    return jsonb_build_object('ok', false, 'reason', 'paused');
  end if;
  v_connection := kma_internal.workspace_stripe_connection(g.workspace_id);
  if v_connection is null or not coalesce((v_connection->>'charges_enabled')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'no_connection');
  end if;

  if v_click is not null then
    select * into v_found from kma_internal.program_sale_click(g.product_id, v_click);
    if v_found.click_record_id is null then
      v_click := null;
    else
      select c.stripe_promotion_code_id into v_promo
      from public.affiliate_program_members m
      join public.program_promo_codes c on c.program_id = m.program_id and c.member_id = m.id and c.status = 'active'
        and c.account_id = v_connection->>'account_id'
      where m.program_id = g.id and m.affiliate_id = v_found.affiliate_id and m.status = 'active';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'program_name', g.name,
    'account_id', v_connection->>'account_id',
    'currency', kma_internal.program_link_currency(g),
    'product', jsonb_build_object('name', g.checkout_name, 'amount_minor', g.checkout_amount_minor,
      'interval', g.checkout_interval),
    'success_url', g.checkout_success_url,
    'cancel_url', regexp_replace(g.checkout_success_url, '^(https://[^/?#]+).*$', '\1/'),
    'click', v_click,
    'promotion_code_id', v_promo,
    'buyer_discount_bps', (select kma_internal.program_terms_discount(t.terms) from public.affiliate_program_terms t
      where t.program_id = g.id and t.version = g.live_terms_version));
end $$;

-- Who may call what ----------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal' and p.proname like 'program\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
  public.claim_program_promo_codes(jsonb),
  public.finish_program_promo_code(jsonb),
  public.program_checkout_target(jsonb),
  public.record_program_sale(jsonb),
  public.workspace_program_save(uuid, jsonb),
  public.workspace_program_submit(uuid, integer),
  public.review_admin_program(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.claim_program_promo_codes(jsonb),
  public.finish_program_promo_code(jsonb),
  public.program_checkout_target(jsonb),
  public.record_program_sale(jsonb)
to service_role;
grant execute on function
  public.workspace_program_save(uuid, jsonb),
  public.workspace_program_submit(uuid, integer),
  public.review_admin_program(jsonb)
to authenticated;

commit;

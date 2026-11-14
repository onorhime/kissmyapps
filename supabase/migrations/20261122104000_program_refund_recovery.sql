-- Attribution Phase 3, piece F: the affiliate money follow-ups the owner decided on 2026-11-13.
--
-- 1. Programs pay creators in US dollars for now. Saving a program in another currency is
--    refused (DETAIL invalid_input, "Programs pay creators in US dollars for now."), and so is
--    sending a program that was never published for review, or approving it, in another
--    currency. A program that already has another currency keeps it: it can still be saved,
--    published again, paused and resumed in that currency. No program is changed here.
-- 2. The agreement says, where it applies to the terms: what commission is worked out on (a
--    share of each sale), that sales on the program's checkout link (a checkout-link program)
--    and app store purchases reported by RevenueCat or Adapty (any program that pays for
--    sales) count like any other sale, and that a refund after approval, even after a payout,
--    is taken from the creator's later earnings in the program and never billed to them. A
--    sale paid with a creator's promo code was already credited to them over any link click,
--    and the agreement already said so. Published terms keep the document creators accepted;
--    the next version a merchant publishes carries the new wording.
-- 3. A refund after approval is carried over. The approved branch of
--    kma_internal.program_commission_apply takes back the whole refunded share as a clawback,
--    even when that takes the creator's sum for the program below zero. The merchant gets back
--    now only what the creator's sum covered; the rest is recorded on the commission as still
--    owed back to the merchant (program_commissions.recovery_due_minor). The KissMyApps fee on
--    the refunded share goes back to the merchant now. Whenever the creator's sum for the
--    program grows again (a sale or a reward approved, a payout that failed or was canceled),
--    the part that brings it back toward zero is paid to the merchant's balance against the
--    oldest commissions still owed, first in first out (kma_internal.program_creator_recover,
--    a trigger on program_creator_entries). Payouts already pay only programs whose sum is
--    above zero (kma_internal.program_payout_sums), so a program below zero is left out of a
--    payout and the creator's other programs are not touched.
--
-- What always holds, checked at the end of every change, inside the same transaction:
--   * a commission's balance entries add up to minus what it holds now and what it still
--     owes back: -(amount_minor + fee_minor + recovery_due_minor)
--     (program_commission_check, program_reward_commission_check);
--   * per creator and program, the commissions' recovery_due_minor add up to exactly how far
--     the creator's sum is below zero, and to nothing while it is not
--     (program_creator_recovery_check).
--
-- Locks keep the documented order: the sale (or the award, or the payout), its commission,
-- the creator's sum (kma_internal.program_creator_lock), the creator's recovery lock
-- (kma_internal.program_recovery_lock, new), the balance. Every change of recovery_due_minor
-- holds the recovery lock. A refund after approval and a payout given back hold the sum and
-- wait for the recovery lock. An approval holds no sum, as before, and never waits: it takes
-- the recovery lock, and then the old commissions it pays back, without waiting, and when
-- another transaction has either it fails with SQLSTATE 55P03 (DETAIL creator_busy), undone
-- as a whole, and the tick tries it again on its next run. A payout that gives money back
-- locks those commissions first, before the creator's sums, so it does not meet that. Making
-- a payout takes no new lock: it pays only sums above zero, where nothing is owed back.
begin;

-- 1. US dollars ------------------------------------------------------------------------------

-- A program that was never published goes to review, and live, only in US dollars. A program
-- that was published in another currency before this rule keeps it (first_published_at is
-- set), so pausing, resuming and publishing new terms are untouched.
create function kma_internal.program_require_usd() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kma_internal.program_fail('invalid_input', 'Programs pay creators in US dollars for now.');
  return new;
end $$;
create trigger affiliate_programs_require_usd
  before update of status on public.affiliate_programs
  for each row when (new.status is distinct from old.status and new.status in ('in_review', 'live')
    and old.first_published_at is null and new.currency <> 'USD')
  execute function kma_internal.program_require_usd();

-- The definition from 20261121101000_program_checkout_promo.sql, with one change: programs
-- pay creators in US dollars for now. The currency of a new program is USD; a program saved in
-- another currency before this rule keeps it, and saving it in that currency still works, but
-- no program moves to a currency other than USD (invalid_input). A code that is not a
-- currency with two decimal places is still refused first, as before (invalid_currency).
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
  -- Programs pay creators in US dollars for now. A program saved in another currency before
  -- this rule keeps it and can still be saved in it, but no program moves to another one.
  if n.currency <> 'USD' and n.currency is distinct from p.currency then
    perform kma_internal.program_fail('invalid_input', 'Programs pay creators in US dollars for now.');
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

-- 2. The agreement ---------------------------------------------------------------------------

-- What commission is worked out on, for terms that pay a share of each sale (null otherwise):
-- what kma_internal.program_sale_basis takes, the payment without tax and, for an app store
-- purchase, without the store's cut. Stripe's own processing fee is not taken off a sale.
create function kma_internal.program_agreement_basis(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when kma_internal.program_terms_earn_from(p_terms) <> 'events' and p_terms->>'commission_type' = 'percent'
    then 'Commission is worked out on what the customer paid after tax and, for a purchase made in an app store, '
      || 'after the app store''s fee.' end
$$;

-- The last paragraph of "How a sale is credited to you": app store purchases count like any
-- other sale, and so do sales on the checkout a checkout-link program's link opens. Any
-- program that pays for sales can receive store purchases (a store tool is connected to the
-- workspace, not named in the terms), so every sales agreement says so. The sentences join
-- the paragraph that was there, so the section keeps its number of paragraphs.
create function kma_internal.program_agreement_counted(p_brand text, p_checkout boolean) returns text
language sql immutable set search_path = '' as $$
  select case when p_checkout
      then format('Sales made on the checkout your link opens, and app store purchases that %s reports to KissMyApps '
        || 'through RevenueCat or Adapty, count like any other sale. ', p_brand)
      else format('App store purchases that %s reports to KissMyApps through RevenueCat or Adapty count like any other sale. ',
        p_brand)
    end
    || 'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link '
    || 'earns no commission.'
$$;

-- The definition from 20261121101000_program_checkout_promo.sql, with the wording of
-- 2026-11-13: section 3 says what a share of a sale is worked out on (percent commission),
-- section 4 says that sales on the checkout link (checkout-link programs) and app store
-- purchases count like any other sale, and section 5 says that a refund after approval, even
-- after a payout, is taken from later commission in the program and never billed. Every
-- sales agreement changes, so its hash changes: published terms keep the document creators
-- accepted, and the Program page shows the new wording as something to publish.
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
  v_basis text;
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
  v_basis := kma_internal.program_agreement_basis(p_terms);
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
    kma_internal.program_section('3. Commission', variadic array_remove(array[
      case v_duration
        when 'first_payment' then format('You earn %s the first payment from each customer whose sale is credited to you. '
          || 'Renewals and other later payments from that customer do not earn commission.', v_amount)
        when 'months' then format('You earn %s every payment credited to you, for %s counted from the customer''s first payment. '
          || 'Payments after that do not earn commission.', v_amount,
          kma_internal.program_count((p_terms->>'commission_months')::integer, 'month'))
        else format('You earn %s every payment credited to you, with no time limit.', v_amount)
      end,
      v_basis,
      'Section 4 explains which payments are credited to you.'],
      null)),
    kma_internal.program_section('4. How a sale is credited to you', variadic array_remove(array[
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      v_code_offer,
      v_code_rule,
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      kma_internal.program_agreement_counted(v_brand, v_checkout is not null)],
      null)),
    kma_internal.program_section('5. Hold, refunds and chargebacks',
      case when v_hold > 0
        then format('Commission is held for %s after each payment before it can be paid out. This leaves time for refunds and disputes.',
          kma_internal.program_count(v_hold, 'day'))
        else 'There is no hold. Commission is ready for payout once KissMyApps has confirmed the payment.'
      end,
      'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
      'If that happens after the commission was approved, even after it was paid out to you, the amount is taken from '
        || 'your later commission in this program. You are never billed for it.'),
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

-- The definition from 20261121101000_program_checkout_promo.sql, with the same wording for a
-- program that pays for sales and events: what a share of a sale is worked out on, sales on
-- the checkout link and app store purchases, and refunds after approval. A program that pays
-- for events only has no sales and no refunds, and its document is unchanged.
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
      kma_internal.program_agreement_basis(p_terms),
      'Section 4 explains which payments are credited to you.');
    s := kma_internal.program_section_add(s, 'How a sale is credited to you',
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      v_code_offer,
      v_code_rule,
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      kma_internal.program_agreement_counted(v_brand, v_checkout is not null));
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
      'If that happens after the commission was approved, even after it was paid out to you, the amount is taken from '
        || 'what you earn later in this program. You are never billed for it.');
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

-- 3. Refund carry-over -----------------------------------------------------------------------

-- What a refunded commission still owes back to the merchant: the part of a refund after
-- approval that the creator's sum for the program could not cover when it came. Only an
-- approved commission owes anything, and never more than it earned. Lowered, oldest first,
-- as the creator earns again in the program (kma_internal.program_creator_recover).
alter table public.program_commissions
  add column recovery_due_minor bigint not null default 0,
  add constraint program_commission_recovery_due check (
    recovery_due_minor >= 0 and recovery_due_minor <= earned_minor
    and (recovery_due_minor = 0 or status = 'approved'));
-- The recovery reads a creator's commissions that still owe something in this order: oldest
-- first, by when the commission was made, then when it was approved (two made in one
-- transaction have the same time), then its id.
create index program_commissions_recovery on public.program_commissions(affiliate_id, program_id, created_at, approved_at, id)
  where recovery_due_minor > 0;

-- What a creator still owes back in a program changes under this lock, taken after the
-- creator's sum (kma_internal.program_creator_lock) by whoever holds that too: a refund
-- after approval and a payout given back wait for it. An approval holds no sum, so it does
-- not wait: when another transaction has the lock, the approval fails with SQLSTATE 55P03
-- (DETAIL creator_busy), is undone, and is tried again on the next tick. A payout only pays a
-- sum above zero, where nothing is owed back, so it does not need this lock.
create function kma_internal.program_recovery_lock(p_program uuid, p_affiliate uuid, p_wait boolean) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_key bigint := hashtextextended('kma-program-recovery:' || p_program::text || ':' || p_affiliate::text, 0);
begin
  if p_wait then
    perform pg_advisory_xact_lock(v_key);
  elsif not pg_try_advisory_xact_lock(v_key) then
    raise exception 'This creator''s earnings are being changed. Try again in a moment'
      using errcode = '55P03', detail = 'creator_busy';
  end if;
end $$;

-- The definition from 20261121102000_program_store_sales.sql, with the new rule for a refund
-- after approval (the approved branch): the whole refunded share is clawed back, the merchant
-- gets back now what the creator's sum covered and is owed the rest (recovery_due_minor), and
-- the fee on the refunded share goes back now. Locks: the sale, its commission, the creator's
-- sum, the creator's recovery lock (new), the balance.
create or replace function kma_internal.program_commission_apply(p_sale_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_sale public.program_sales;
  c public.program_commissions;
  v_refunded bigint;
  v_account uuid;
  v_cap bigint;
  v_amount bigint;
  v_fee bigint;
  v_owed bigint;
  v_take bigint;
  v_covered bigint;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_sale from public.program_sales s where s.id = p_sale_id for no key update;
  if not found then
    return;
  end if;
  select * into c from public.program_commissions x where x.sale_id = p_sale_id for no key update;
  v_refunded := kma_internal.program_commission_refunded(v_sale);

  if c.id is null then
    -- A sale recorded before the switch was turned on is never judged.
    if v_sale.created_at < (select s.program_money_enabled_at from public.platform_settings s where s.singleton) then
      return;
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, null);

  elsif c.status = 'not_earned' then
    -- Final, except a sale nobody was credited for that now has a creator.
    if c.reason = 'no_creator' and v_sale.affiliate_id is not null then
      perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);
    else
      return;
    end if;

  elsif c.status = 'held' and v_sale.affiliate_id is distinct from c.affiliate_id then
    -- The sale moved to another creator, or to nobody: everything set aside goes back and
    -- the sale is judged again from the top.
    select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
    if c.amount_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor, null, c.id);
    end if;
    if c.fee_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor, null, c.id);
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);

  elsif c.status in ('held', 'approved') then
    -- What the commission may still be: never more than it is, less when part of the
    -- payment was refunded (or tax turned out higher than first known).
    v_cap := least(c.earned_minor, kma_internal.program_commission_of(c.commission_type, c.commission_rate_bps,
      c.commission_fixed_minor, kma_internal.program_sale_basis(v_sale)));
    v_amount := least(c.amount_minor, kma_internal.program_commission_part(v_cap, v_sale.amount_minor, v_refunded));
    if v_amount is null then
      raise exception 'Commission % cannot be worked out again', c.id using errcode = 'P0001';
    end if;

    if c.status = 'held' then
      v_fee := case when v_amount = 0 then 0 else least(c.fee_minor, kma_internal.program_commission_part(
        div(v_cap::numeric * c.fee_bps, 10000)::bigint, v_sale.amount_minor, v_refunded)) end;
      if v_amount = c.amount_minor and v_fee = c.fee_minor then
        return;
      end if;
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      if v_amount < c.amount_minor then
        perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor - v_amount, null, c.id);
      end if;
      if v_fee < c.fee_minor then
        perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor - v_fee, null, c.id);
      end if;
      update public.program_commissions set
        amount_minor = v_amount, fee_minor = v_fee,
        status = case when v_amount = 0 then 'reversed' else 'held' end,
        reversed_at = case when v_amount = 0 then v_now end,
        updated_at = v_now
      where id = c.id;

    else
      -- Approved: the commission is the creator's. A refund takes back the whole refunded
      -- share from what the creator has coming from this program, even when that takes their
      -- sum below zero. The merchant gets back now the part their sum covered; the rest is
      -- owed back to the merchant (recovery_due_minor) and is paid from the creator's later
      -- earnings in the program (kma_internal.program_creator_recover). The fee on the
      -- refunded share goes back now, worked out the way the hold works it out.
      v_fee := case when v_amount = 0 then 0 else least(c.fee_minor, kma_internal.program_commission_part(
        div(v_cap::numeric * c.fee_bps, 10000)::bigint, v_sale.amount_minor, v_refunded)) end;
      if v_amount = c.amount_minor and v_fee = c.fee_minor then
        return;
      end if;
      v_take := c.amount_minor - v_amount;
      perform kma_internal.program_creator_lock(c.program_id, c.affiliate_id);
      perform kma_internal.program_recovery_lock(c.program_id, c.affiliate_id, true);
      select coalesce(sum(e.amount_minor), 0) into v_owed from public.program_creator_entries e
      where e.affiliate_id = c.affiliate_id and e.program_id = c.program_id;
      v_covered := least(v_take, greatest(v_owed, 0));
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      if v_take > 0 then
        insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
        values (c.affiliate_id, c.program_id, c.currency, 'clawback', -v_take, c.id);
      end if;
      if v_covered > 0 then
        perform kma_internal.program_balance_post(v_account, 'commission_returned', v_covered, null, c.id);
      end if;
      if v_fee < c.fee_minor then
        perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor - v_fee, null, c.id);
      end if;
      update public.program_commissions set
        amount_minor = v_amount, fee_minor = v_fee, recovery_due_minor = recovery_due_minor + v_take - v_covered,
        updated_at = v_now
      where id = c.id;
    end if;

  else
    -- Reversed: nothing more can happen to it.
    return;
  end if;

  perform kma_internal.program_commission_check(p_sale_id);
  if c.status = 'approved' then
    perform kma_internal.program_creator_recovery_check(c.program_id, c.affiliate_id);
  end if;
end $$;

-- The definition from 20261116101000_program_commissions.sql, with what a commission still owes
-- back: its balance entries add up to minus what it has set aside now and minus what it still
-- owes back to the merchant, so what is still due is exactly recovery_due_minor.
create or replace function kma_internal.program_commission_check(p_sale_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  v_balance bigint;
  v_creator bigint;
begin
  select * into c from public.program_commissions x where x.sale_id = p_sale_id;
  if not found then
    return;
  end if;
  select coalesce(sum(e.amount_minor), 0) into v_balance
  from public.program_balance_entries e where e.commission_id = c.id;
  select coalesce(sum(e.amount_minor), 0) into v_creator
  from public.program_creator_entries e where e.commission_id = c.id;
  if v_balance <> -(c.amount_minor + c.fee_minor + c.recovery_due_minor)
    or v_creator <> (case when c.status = 'approved' then c.amount_minor else 0 end) then
    raise exception 'Commission % does not agree with its entries', c.id
      using errcode = 'P0001', detail = 'commission_out_of_balance';
  end if;
end $$;

-- The definition from 20261119102000_program_reward_engine.sql, with recovery_due_minor in the
-- balance equation, like a sale's commission. A reward is never refunded, so it never owes
-- anything back; the equation is the same for both so that one rule holds everywhere.
create or replace function kma_internal.program_reward_commission_check(p_commission uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  a public.program_reward_awards;
  v_balance bigint;
  v_creator bigint;
begin
  select * into c from public.program_commissions x where x.id = p_commission and x.award_id is not null;
  if not found then
    return;
  end if;
  select * into a from public.program_reward_awards w where w.id = c.award_id;
  select coalesce(sum(e.amount_minor), 0) into v_balance
  from public.program_balance_entries e where e.commission_id = c.id;
  select coalesce(sum(e.amount_minor), 0) into v_creator
  from public.program_creator_entries e where e.commission_id = c.id;
  if v_balance <> -(c.amount_minor + c.fee_minor + c.recovery_due_minor)
    or v_creator <> (case when c.status = 'approved' then c.amount_minor else 0 end)
    or a.status is distinct from (case when c.status in ('held', 'approved') then 'earned'
      when c.status = 'reversed' then 'rejected' end)
    or (c.status in ('held', 'approved') and c.amount_minor <> a.amount_minor)
    or c.program_id <> a.program_id or c.affiliate_id <> a.affiliate_id then
    raise exception 'Reward commission % does not agree with its entries', c.id
      using errcode = 'P0001', detail = 'commission_out_of_balance';
  end if;
end $$;

-- Raises unless what a creator's commissions in a program still owe back to the merchant adds
-- up to exactly how far the creator's sum for that program is below zero, and to nothing
-- while it is not. Run under the creator's recovery lock at the end of every change that
-- writes a clawback or adds to the sum.
create function kma_internal.program_creator_recovery_check(p_program uuid, p_affiliate uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_sum bigint;
  v_due bigint;
begin
  select coalesce(sum(e.amount_minor), 0) into v_sum from public.program_creator_entries e
  where e.affiliate_id = p_affiliate and e.program_id = p_program;
  select coalesce(sum(x.recovery_due_minor), 0) into v_due from public.program_commissions x
  where x.affiliate_id = p_affiliate and x.program_id = p_program and x.recovery_due_minor > 0;
  if v_due <> greatest(-v_sum, 0) then
    raise exception 'What creator % owes back in program % does not agree with their entries', p_affiliate, p_program
      using errcode = 'P0001', detail = 'recovery_out_of_balance';
  end if;
end $$;

-- Paying the merchant back from later earnings. Runs after every entry that adds to what a
-- creator has coming from a program: a commission approved (sale or reward), a payout given
-- back (failed or canceled). Under the creator's recovery lock it pays back, against the
-- commissions that still owe something, oldest first, the part of what was owed that the
-- creator's sum no longer covers being below zero: with the sum at -S before the entry
-- (S > 0), least(the entry, S). Each part is a commission_returned entry of the merchant's balance on the old
-- commission, noted as recovered, and lowers its recovery_due_minor.
-- The recovery takes the creator's recovery lock without waiting (an approval holds no sum;
-- a payout given back already holds it), then locks the old commissions without waiting: a
-- lock that another transaction holds fails the whole change with 55P03 creator_busy, to be
-- tried again.
create function kma_internal.program_creator_recover() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sum bigint;
  v_due bigint;
  v_left bigint;
  v_part bigint;
  v_account uuid;
  d record;
begin
  perform kma_internal.program_recovery_lock(new.program_id, new.affiliate_id, false);
  select coalesce(sum(e.amount_minor), 0) into v_sum from public.program_creator_entries e
  where e.affiliate_id = new.affiliate_id and e.program_id = new.program_id;
  select coalesce(sum(x.recovery_due_minor), 0) into v_due from public.program_commissions x
  where x.affiliate_id = new.affiliate_id and x.program_id = new.program_id and x.recovery_due_minor > 0;
  -- After this entry, what is still owed back is how far the sum is still below zero.
  v_left := least(new.amount_minor, v_due - greatest(-v_sum, 0));
  if v_left > 0 then
    select a.id into v_account from public.program_balance_accounts a where a.program_id = new.program_id;
    begin
      for d in
        select x.id, x.sale_id, x.recovery_due_minor from public.program_commissions x
        where x.affiliate_id = new.affiliate_id and x.program_id = new.program_id and x.recovery_due_minor > 0
        order by x.created_at, x.approved_at, x.id
        for no key update nowait
      loop
        v_part := least(v_left, d.recovery_due_minor);
        update public.program_commissions set
          recovery_due_minor = recovery_due_minor - v_part, updated_at = clock_timestamp()
        where id = d.id;
        perform kma_internal.program_balance_post(v_account, 'commission_returned', v_part, null, d.id,
          'Refund recovered from the creator''s later earnings');
        perform kma_internal.program_commission_check(d.sale_id);
        perform kma_internal.program_reward_commission_check(d.id);
        v_left := v_left - v_part;
        exit when v_left = 0;
      end loop;
    exception when lock_not_available then
      raise exception 'This creator''s earnings are being changed. Try again in a moment'
        using errcode = '55P03', detail = 'creator_busy';
    end;
  end if;
  perform kma_internal.program_creator_recovery_check(new.program_id, new.affiliate_id);
  return null;
end $$;
create trigger program_creator_entries_recover
  after insert on public.program_creator_entries
  for each row when (new.amount_minor > 0)
  execute function kma_internal.program_creator_recover();

-- The definition from 20261117101000_program_payouts.sql, with two more locks: what a payout
-- gives back may pay off refunds the creator still owes in its programs
-- (kma_internal.program_creator_recover), so the commissions that still owe something are
-- locked before the creator's sums, in the order the recovery reads them, and the recovery
-- locks after the sums. The caller holds the payout row; nothing that holds a commission
-- ever waits for a payout.
create or replace function kma_internal.program_payout_reverse(p_payout public.program_payouts) returns void
language plpgsql volatile set search_path = '' as $$
declare i record;
begin
  perform 1 from public.program_commissions x
  where x.affiliate_id = p_payout.affiliate_id and x.recovery_due_minor > 0
    and x.program_id in (select t.program_id from public.program_payout_items t where t.payout_id = p_payout.id)
  order by x.program_id, x.created_at, x.approved_at, x.id
  for no key update of x;
  for i in select t.program_id from public.program_payout_items t where t.payout_id = p_payout.id order by t.program_id loop
    perform kma_internal.program_creator_lock(i.program_id, p_payout.affiliate_id);
  end loop;
  for i in select t.program_id from public.program_payout_items t where t.payout_id = p_payout.id order by t.program_id loop
    perform kma_internal.program_recovery_lock(i.program_id, p_payout.affiliate_id, true);
  end loop;
  insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id)
  select p_payout.affiliate_id, t.program_id, p_payout.currency, 'payout_reversed', t.amount_minor, p_payout.id
  from public.program_payout_items t where t.payout_id = p_payout.id order by t.program_id;
end $$;

-- What creators, merchants and KissMyApps read --------------------------------------------------
-- A creator's sum for a program can now be below zero. No read shows a negative amount to be
-- paid: approved_minor (what is still the creator's to be paid in a program) is never below
-- zero, and what KissMyApps owes creators adds up the programs that are above zero. The
-- shapes are unchanged: none has a place for a refund still being recovered. On the Balance
-- page a recovery is a "commission_returned" line with the note "Refund recovered from the
-- creator's later earnings".

-- The definition from 20261119103000_program_reward_numbers.sql, with approved_minor never
-- below zero: a program whose refunds are still being taken from later earnings has nothing
-- to be paid, not a negative amount.
create or replace function public.partner_program_earnings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := public.current_partner_affiliate_id(true);
  v_platform text := kma_internal.program_payout_platform();
begin
  -- The payout account is offered to a creator who is in a program on the platform.
  if v_platform is not null and not exists (
    select 1 from public.program_balance_accounts b
    where b.platform_account_id = v_platform and (
      exists (select 1 from public.affiliate_program_members m
        where m.program_id = b.program_id and m.affiliate_id = v_affiliate)
      or exists (select 1 from public.program_creator_entries e
        where e.program_id = b.program_id and e.affiliate_id = v_affiliate))) then
    v_platform := null;
  end if;
  return jsonb_build_object(
    'programs', coalesce((
      select jsonb_agg(jsonb_build_object(
          'program_id', p.id, 'slug', p.slug, 'name', p.name,
          'currency', coalesce(
            (select a.currency from public.program_balance_accounts a where a.program_id = p.id),
            cm.currency, en.currency),
          'pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor,
          'paying_minor', en.paying_minor, 'paid_minor', en.paid_minor,
          'sales', cm.sales, 'events', cm.events, 'next_release_at', cm.next_release_at)
        order by p.name, p.id)
      from (
        select x.program_id from public.program_commissions x
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        union
        select e.program_id from public.program_creator_entries e where e.affiliate_id = v_affiliate) k
      join public.affiliate_programs p on p.id = k.program_id
      cross join lateral (
        select coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
          count(*) filter (where x.status in ('held', 'approved') and x.award_id is null) as sales,
          count(*) filter (where x.status in ('held', 'approved') and w.status = 'earned') as events,
          min(x.hold_until) filter (where x.status = 'held') as next_release_at,
          max(x.currency) filter (where x.status <> 'not_earned') as currency
        from public.program_commissions x
        left join public.program_reward_awards w on w.id = x.award_id
        where x.program_id = p.id and x.affiliate_id = v_affiliate) cm
      cross join lateral (
        select greatest(coalesce(sum(e.amount_minor), 0), 0)::bigint as approved_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status in ('approved', 'processing')), 0)::bigint
            as paying_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status = 'paid'), 0)::bigint as paid_minor,
          max(e.currency) as currency
        from public.program_creator_entries e
        left join public.program_payouts o on o.id = e.payout_id
        where e.program_id = p.id and e.affiliate_id = v_affiliate) en), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'program_id', q.program_id, 'program_name', q.program_name, 'status', q.status,
          'amount_minor', q.amount_minor, 'earned_minor', q.earned_minor, 'currency', q.currency,
          'sale_amount_minor', q.sale_amount_minor, 'paid_at', q.paid_at,
          'hold_until', q.hold_until, 'approved_at', q.approved_at,
          'kind', q.kind, 'reward_label', q.reward_label)
        order by q.place)
      from (
        -- A reward has no payment: it is placed by when its event happened.
        select x.id, x.program_id, p.name as program_name, x.status, x.amount_minor, x.earned_minor, x.currency,
          s.amount_minor as sale_amount_minor, coalesce(s.paid_at, w.occurred_at) as paid_at, x.hold_until, x.approved_at,
          case when x.award_id is null then 'sale' else 'reward' end as kind, w.reward_label,
          row_number() over (order by coalesce(s.paid_at, w.occurred_at) desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        left join public.program_sales s on s.id = x.sale_id
        left join public.program_reward_awards w on w.id = x.award_id
        join public.affiliate_programs p on p.id = x.program_id
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 50) q), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'amount_minor', q.amount_minor, 'currency', q.currency, 'status', q.status,
          'created_at', q.created_at, 'paid_at', q.paid_at)
        order by q.created_at desc, q.id)
      from (
        select o.id, o.amount_minor, o.currency, o.status, o.created_at, o.paid_at
        from public.program_payouts o where o.affiliate_id = v_affiliate
        order by o.created_at desc, o.id limit 20) q), '[]'::jsonb),
    'payout', jsonb_build_object(
      'enabled', kma_internal.program_payouts_enabled(),
      'min_payout_minor', coalesce((select s.program_min_payout_minor from public.platform_settings s where s.singleton), 2500),
      'platform_account_id', v_platform,
      'payable', coalesce((
        select jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_minor', x.total) order by x.currency)
        from (select s.currency, sum(s.amount_minor)::bigint as total
          from kma_internal.program_payout_sums(v_platform, v_affiliate) s group by s.currency) x), '[]'::jsonb)));
end $$;

-- The definition from 20261118100000_program_links.sql, with approved_minor never below zero,
-- the same as the program's line of partner_program_earnings.
create or replace function kma_internal.program_link_money(p_program uuid, p_affiliate uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor,
    'paying_minor', en.paying_minor, 'paid_minor', en.paid_minor, 'next_release_at', cm.next_release_at)
  from (
    select coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
      min(x.hold_until) filter (where x.status = 'held') as next_release_at
    from public.program_commissions x
    where x.program_id = p_program and x.affiliate_id = p_affiliate) cm
  cross join (
    select greatest(coalesce(sum(e.amount_minor), 0), 0)::bigint as approved_minor,
      coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status in ('approved', 'processing')), 0)::bigint
        as paying_minor,
      coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status = 'paid'), 0)::bigint as paid_minor
    from public.program_creator_entries e
    left join public.program_payouts o on o.id = e.payout_id
    where e.program_id = p_program and e.affiliate_id = p_affiliate) en
$$;

-- The definition from 20261116101000_program_commissions.sql, with what is owed to creators
-- added up over the creators' programs that are above zero: a creator's refund still being
-- recovered in one program does not lower what another program owes them, or another creator.
create or replace function kma_internal.program_money_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.program_money_enabled, false),
    'fee_bps', coalesce(s.program_fee_bps, 1000),
    'min_deposit_minor', coalesce(s.program_min_deposit_minor, 5000),
    'updated_at', s.updated_at,
    'programs_with_balance', (select count(*) from public.program_balance_accounts a where a.available_minor > 0),
    'available_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select a.currency, sum(a.available_minor)::bigint as total
        from public.program_balance_accounts a group by a.currency) x),
    'reserved_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select c.currency, sum(c.amount_minor + c.fee_minor)::bigint as total
        from public.program_commissions c where c.status = 'held' group by c.currency) x),
    'owed_to_creators_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select y.currency, sum(greatest(y.owed, 0))::bigint as total
        from (select e.currency, sum(e.amount_minor) as owed from public.program_creator_entries e
          group by e.affiliate_id, e.program_id, e.currency) y
        group by y.currency) x))
  from (select true as present) one
  left join public.platform_settings s on s.singleton
$$;

-- The definition from 20261119102000_program_reward_engine.sql, with recovery_due_minor in the
-- balance equation of ledger_mismatches, as kma_internal.program_reward_commission_check has it.
create or replace function public.program_reward_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  with wanted as (
    select pr.id as project_id, w->>'key' as event_name, p.id as program_id
    from public.affiliate_programs p
    join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
    join public.analytics_projects pr on pr.workspace_id = p.workspace_id
    cross join lateral jsonb_array_elements(kma_internal.program_reward_list(t.terms)) w
    where p.status in ('live', 'paused'))
  select jsonb_build_object(
    'enabled', kma_internal.program_money_enabled(),
    'programs', (select count(distinct e.program_id) from public.program_reward_events e),
    'events_out_of_step',
      (select count(*) from wanted w where not exists (select 1 from public.program_reward_events e
        where e.project_id = w.project_id and e.event_name = w.event_name and e.program_id = w.program_id))
      + (select count(*) from public.program_reward_events e where not exists (select 1 from wanted w
        where e.project_id = w.project_id and e.event_name = w.event_name and e.program_id = w.program_id)),
    'queue', (select jsonb_build_object(
        'due', count(*) filter (where q.next_attempt_at <= now()),
        'waiting', count(*) filter (where q.next_attempt_at > now()),
        'failing', count(*) filter (where q.attempts > 0),
        'oldest_enqueued_at', min(q.enqueued_at))
      from public.program_reward_queue q),
    'errors', (select coalesce(jsonb_object_agg(r.last_error, r.n), '{}'::jsonb)
      from (select q.last_error, count(*) as n from public.program_reward_queue q
        where q.last_error is not null group by q.last_error) r),
    'awards_last_day', (select coalesce(jsonb_object_agg(r.label, r.n), '{}'::jsonb)
      from (select coalesce(a.reason, a.status) as label, count(*) as n from public.program_reward_awards a
        where a.created_at > now() - interval '1 day' group by 1) r),
    'held_due', (select count(*) from public.program_commissions x
      where x.status = 'held' and x.award_id is not null and x.hold_until <= now()),
    'ledger_mismatches', (select count(*) from public.program_commissions c
      join public.program_reward_awards a on a.id = c.award_id
      where -(c.amount_minor + c.fee_minor + c.recovery_due_minor) <> coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.commission_id = c.id), 0)
        or (case when c.status = 'approved' then c.amount_minor else 0 end) <> coalesce((select sum(e.amount_minor)
          from public.program_creator_entries e where e.commission_id = c.id), 0)
        or a.status is distinct from (case when c.status in ('held', 'approved') then 'earned'
          when c.status = 'reversed' then 'rejected' end))
      + (select count(*) from public.program_reward_awards a
        where a.status <> 'not_earned' and not exists (select 1 from public.program_commissions c where c.award_id = a.id)))
$$;

-- Who may call what ------------------------------------------------------------------------------
-- The functions made here are internal, closed to every API role like the rest of the program
-- engine. The public functions replaced here keep the grants they had.
revoke all on function
    kma_internal.program_require_usd(),
    kma_internal.program_agreement_basis(jsonb),
    kma_internal.program_agreement_counted(text, boolean),
    kma_internal.program_recovery_lock(uuid, uuid, boolean),
    kma_internal.program_creator_recovery_check(uuid, uuid),
    kma_internal.program_creator_recover()
  from public, anon, authenticated, service_role;

commit;

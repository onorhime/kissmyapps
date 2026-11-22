begin;

-- Public links belong to the deployed partner host. Historical signed agreements stay immutable.

create or replace function kma_internal.program_checkout_url(p_slug text) returns text
language sql immutable set search_path = '' as $$
  select 'https://partners.kissmyapps.dev/checkout/' || p_slug
$$;

update public.funnels f set destination_url = kma_internal.program_checkout_url(p.slug)
from public.affiliate_programs p where p.funnel_id = f.id and p.payment_mode = 'kma_checkout'
and f.destination_url = 'https://kissmyapps.dev/checkout/' || p.slug;
update public.affiliate_programs set landing_url = kma_internal.program_checkout_url(slug)
where payment_mode = 'kma_checkout' and landing_url = 'https://kissmyapps.dev/checkout/' || slug;

create function kma_internal.program_platform_minimum() returns bigint
language sql stable set search_path = '' as $$
  select coalesce((select program_min_payout_minor from public.platform_settings where singleton), 2500)
$$;
revoke all on function kma_internal.program_platform_minimum() from public, anon, authenticated;

create or replace function kma_internal.program_terms(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'program_name', p.name, 'payout_policy', 'pooled',
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
    'minimum_payout_minor', kma_internal.program_platform_minimum(),
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
    'minimum_payout_minor', kma_internal.program_platform_minimum(),
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
      'platform_minimum_minor', kma_internal.program_platform_minimum(),
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
    'platform_minimum_minor', kma_internal.program_platform_minimum(),
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
  -- Validate legacy clients' field without allowing them to override the platform payout policy.
  perform kma_internal.program_input_int(p_input, 'minimum_payout_minor', p.minimum_payout_minor, 0, 100000000, 2500);
  n.minimum_payout_minor := kma_internal.program_platform_minimum();
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
        then format(case when p_terms->>'payout_policy' = 'pooled' then 'Commission becomes payable %s. KissMyApps combines approved earnings across your programs in this currency. The platform payout minimum at publication is %s. Your Earnings page shows the current minimum.' else 'Commission becomes payable %s. It is paid when your payable commission reaches %s.' end, v_cleared, v_minimum_text)
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
        then format(case when p_terms->>'payout_policy' = 'pooled' then 'KissMyApps combines approved earnings across programs in this currency. The platform payout minimum at publication is %s. Your Earnings page shows the current minimum.' else 'They are paid when what is payable to you reaches %s.' end, v_minimum_text)
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

create or replace function kma_internal.program_agreement_basis(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when kma_internal.program_terms_earn_from(p_terms) <> 'events' and p_terms->>'commission_type' = 'percent'
    then case when p_terms->>'payout_policy' = 'pooled' then 'Commission is worked out on the payment amount excluding tax and, for a purchase made in an app store, ' else 'Commission is worked out on what the customer paid after tax and, for a purchase made in an app store, ' end
      || 'after the app store''s fee.' end
$$;

-- A provider may deliver the refund before the sale. Store only normalized refund amounts.
alter table public.program_store_events add column refund_details jsonb;
create index program_store_refunds_pending on public.program_store_events(transaction_id, connection_id)
  where outcome = 'ignored_no_sale' and type = 'refund';
-- Older unmatched refunds lack normalized refund amounts. Redelivery supplies those amounts.

create function kma_internal.apply_store_refund(p_receipt uuid, p_sale uuid, p_details jsonb) returns void
language plpgsql volatile set search_path = '' as $$
declare
  s public.program_sales;
  v_refund bigint;
begin
  select * into strict s from public.program_sales where id = p_sale for update;
  v_refund := case
    when p_details->>'currency' = s.currency and (p_details->>'refunded_minor')::bigint > 0 then (p_details->>'refunded_minor')::bigint
    when s.currency = 'USD' and (p_details->>'usd_minor')::bigint > 0 then (p_details->>'usd_minor')::bigint
    else s.amount_minor end;
  v_refund := least(v_refund, s.amount_minor - s.refunded_minor);
  if v_refund > 0 then
    insert into public.program_sale_events(sale_id, kind, stripe_object_id, state, amount_minor, currency, occurred_at)
      values (s.id, 'refund', 'store_' || replace(p_receipt::text, '-', ''), 'succeeded', v_refund, s.currency, clock_timestamp());
    update public.program_sales set refunded_minor = refunded_minor + v_refund, verified_at = clock_timestamp() where id = s.id;
    perform kma_internal.program_sale_refresh_status(s.id);
  end if;
end $$;
revoke all on function kma_internal.apply_store_refund(uuid, uuid, jsonb) from public, anon, authenticated;

-- Keep only the normalized transaction fields and project-scoped identifier digests needed for delayed identity resolution.
alter table public.program_store_events add column retry_input jsonb, add column identity_digests text[], add column retry_after timestamptz;
create index program_store_events_due on public.program_store_events(retry_after) where retry_after is not null;

create or replace function public.record_program_store_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.program_store_connections;
  r public.program_store_events;
  g public.affiliate_programs;
  s public.program_sales;
  v_first public.program_sales;
  v_click record;
  v_type text := p->>'type';
  v_env text := p->>'environment';
  v_store text := p->>'store';
  v_tx text := p->>'transaction_id';
  v_original text := coalesce(p->>'original_transaction_id', p->>'transaction_id');
  v_currency text := upper(p->>'currency');
  v_at timestamptz;
  v_amount bigint;
  v_tax bigint;
  v_fee bigint;
  v_usd_amount bigint;
  v_usd_proceeds bigint;
  v_terms jsonb;
  v_program_currency text;
  v_window integer;
  v_ids text[];
  v_person uuid;
  v_seq bigint;
  v_first_tx text;
  pending record;
  v_details jsonb := jsonb_build_object('currency', v_currency, 'refunded_minor', p->'refunded_minor', 'usd_minor', p->'usd'->'amount_minor');
  v_outcome text;
  v_sale uuid;
  v_new boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object'
    or coalesce(p->>('header' || '_sha256'), '') !~ '^[a-f0-9]{64}$'
    or coalesce(p->>'provider', '') not in ('revenuecat', 'adapty')
    or jsonb_typeof(p->'event_id') is distinct from 'string' or (p->>'event_id') !~ '^[[:print:]]{1,200}$'
    or coalesce(v_type, '') not in ('initial_purchase', 'renewal', 'refund', 'cancellation', 'other')
    or coalesce(v_env, '') not in ('production', 'sandbox')
    or (v_store is not null and v_store not in ('app_store', 'play_store', 'stripe', 'amazon', 'other'))
    or not kma_internal.program_store_text_ok(p, 'app_user_id')
    or not kma_internal.program_store_text_ok(p, 'product_id')
    or not kma_internal.program_store_text_ok(p, 'transaction_id')
    or not kma_internal.program_store_text_ok(p, 'original_transaction_id')
    or (p ? 'aliases' and jsonb_typeof(p->'aliases') not in ('array', 'null'))
    or (jsonb_typeof(p->'aliases') = 'array' and jsonb_array_length(p->'aliases') > 50)
    or not kma_internal.program_sale_amount_ok(p, 'purchased_at', false)
    or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
    or not kma_internal.program_sale_amount_ok(p, 'amount_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'tax_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'store_fee_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'refunded_minor', false)
    or (p ? 'usd' and jsonb_typeof(p->'usd') not in ('object', 'null'))
    or (jsonb_typeof(p->'usd') = 'object' and (not kma_internal.program_sale_amount_ok(p->'usd', 'amount_minor', false)
      or not kma_internal.program_sale_amount_ok(p->'usd', 'proceeds_minor', false)))
  then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;
  v_amount := (p->>'amount_minor')::bigint;
  if (p->>'purchased_at') is not null then
    v_at := to_timestamp((p->>'purchased_at')::bigint);
  end if;
  if v_at is not null and ((p->>'purchased_at')::bigint <= 0 or v_at > clock_timestamp() + interval '10 minutes') then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;
  -- What a sale or a refund needs.
  if v_env = 'production' and v_type in ('initial_purchase', 'renewal', 'refund')
    and (v_tx is null or (v_type <> 'refund' and (v_at is null or v_store is null or (v_amount > 0 and v_currency is null))))
  then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;

  select * into c from public.program_store_connections x
  where x.header_sha256 = p->>('header' || '_sha256') and x.status = 'active' and x.provider = p->>'provider';
  if c.id is null then
    raise exception 'Unknown store connection' using errcode = '28000';
  end if;

  -- Serialize delivery across connections for the same store transaction in this workspace.
  if v_tx is not null then
    perform pg_advisory_xact_lock(hashtextextended(c.workspace_id::text || ':' || c.provider || ':' || v_tx, 0));
  end if;
  insert into public.program_store_events(connection_id, event_id, type, environment, store, product_id,
      transaction_id, original_transaction_id, occurred_at, currency, amount_minor)
    values (c.id, p->>'event_id', v_type, v_env, v_store, p->>'product_id', v_tx,
      case when v_tx is not null then v_original end, v_at, v_currency, v_amount)
    on conflict (connection_id, event_id) do nothing
    returning * into r;
  v_new := r.id is not null;
  if not v_new then
    select * into r from public.program_store_events e where e.connection_id = c.id and e.event_id = p->>'event_id';
    if r.outcome not in ('ignored_no_sale','unmatched_person','unmatched_creator','unmatched_program') then
      return jsonb_build_object('received', true, 'duplicate', true, 'outcome', r.outcome, 'sale_id', r.sale_id,
      'subscription_sequence', (select x.subscription_sequence from public.program_sales x where x.id = r.sale_id));
    end if;
    if r.type <> v_type or r.transaction_id is distinct from v_tx or r.environment <> v_env then
      raise exception 'Conflicting store redelivery' using errcode = '22023';
    end if;
  end if;

  -- The workspace's approved program.
  select x.* into g from public.affiliate_programs x
  where x.workspace_id = c.workspace_id and x.status in ('live', 'paused');
  if g.id is not null then
    perform pg_advisory_xact_lock(hashtextextended('kma-program-store:' || g.id::text, 0));
  end if;

  if v_env = 'sandbox' then
    v_outcome := 'ignored_sandbox';
  elsif v_type = 'other' then
    v_outcome := 'ignored_type';
  elsif v_type = 'cancellation' then
    v_outcome := 'cancellation';

  elsif v_type = 'refund' then
    -- The refunded transaction's sale, in any program of the workspace.
    select x.* into s from public.program_sales x
    join public.affiliate_programs y on y.id = x.program_id and y.workspace_id = c.workspace_id
    where x.source = c.provider and x.store_transaction_id = v_tx
    order by x.paid_at desc limit 1
    for update of x;
    if s.id is null then
      v_outcome := 'ignored_no_sale';
    else
      perform kma_internal.apply_store_refund(r.id, s.id, coalesce(r.refund_details, v_details));
      v_outcome := 'refund';
      v_sale := s.id;
    end if;

  elsif coalesce(v_amount, 0) = 0 then
    v_outcome := 'ignored_free';
  elsif v_store = 'stripe' then
    v_outcome := 'ignored_store';
  elsif g.id is null or v_at < g.first_published_at then
    v_outcome := 'unmatched_program';
  else
    select x.* into s from public.program_sales x
    where x.program_id = g.id and x.source = c.provider and x.store_transaction_id = v_tx;
    if s.id is not null then
      v_outcome := 'sale_exists';
      v_sale := s.id;
    end if;
  end if;

  if v_outcome is null then
    -- A purchase or renewal: its place in the store subscription, then its creator.
    select ch.n into v_seq from kma_internal.program_store_chain(c.project_id, c.provider, v_original) ch
    where ch.transaction_id = v_tx;
    select ch.transaction_id into v_first_tx from kma_internal.program_store_chain(c.project_id, c.provider, v_original) ch
    where ch.n = 1;
    select x.* into v_first from public.program_sales x
    where x.program_id = g.id and x.source = c.provider and x.store_transaction_id = v_first_tx;
    if v_seq > 1 and v_first.click_record_id is not null then
      select v_first.click_id as click_id, v_first.click_record_id as click_record_id,
        v_first.affiliate_id as affiliate_id, 'subscription'::text as match_source into v_click;
    else
      v_ids := array(select distinct on (lower(i.v)) i.v from (
          select p->>'app_user_id' as v, 0 as place
          union all
          select a.value #>> '{}', a.place from jsonb_array_elements(coalesce(p->'aliases', '[]'::jsonb))
            with ordinality a(value, place) where jsonb_typeof(a.value) = 'string') i
        where i.v ~ '^[[:print:]]{1,200}$' order by lower(i.v), i.place);
      -- The app user ID first.
      v_ids := array(select u.v from unnest(v_ids) with ordinality u(v, n)
        order by (u.v = p->>'app_user_id') desc, u.n limit 20);
      v_person := kma_internal.program_store_person(c.project_id, v_ids);
      if v_person is null and r.identity_digests is not null then
        select pe.id into v_person from public.analytics_people pe
        where pe.project_id = c.project_id and exists (
          select from unnest(array_prepend(pe.distinct_id, pe.anonymous_ids)) i
          where encode(extensions.digest(c.project_id::text || ':' || i,'sha256'),'hex') = any(r.identity_digests)
        )
        order by coalesce(encode(extensions.digest(c.project_id::text || ':' || pe.distinct_id,'sha256'),'hex')=r.identity_digests[1],false) desc,
          coalesce(encode(extensions.digest(c.project_id::text || ':' || pe.distinct_id,'sha256'),'hex')=any(r.identity_digests),false) desc, pe.last_seen desc, pe.id limit 1;
      end if;
      if v_person is null then
        v_outcome := 'unmatched_person';
      else
        -- The window creators agreed to: the published terms.
        v_window := coalesce((select (t.terms->>'attribution_window_days')::integer
          from public.affiliate_program_terms t
          where t.program_id = g.id and t.version = g.live_terms_version
            and (t.terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'), g.attribution_window_days);
        select k.click_id, k.click_record_id, k.affiliate_id, 'app_user'::text as match_source into v_click
        from kma_internal.program_store_click(g.product_id, v_person, v_at, v_window) k;
        if v_click.click_record_id is null then
          v_outcome := 'unmatched_creator';
        end if;
      end if;
    end if;
  end if;

  if v_outcome is null then
    -- The sale: the gross price, tax and the store's cut in the purchase currency, or in USD
    -- for a USD program when the tool gave USD figures.
    select t.terms into v_terms from public.affiliate_program_terms t
    where t.program_id = g.id and t.version = g.live_terms_version;
    v_program_currency := coalesce(v_terms->>'currency', g.currency);
    v_tax := (p->>'tax_minor')::bigint;
    v_fee := (p->>'store_fee_minor')::bigint;
    v_usd_amount := (p->'usd'->>'amount_minor')::bigint;
    v_usd_proceeds := (p->'usd'->>'proceeds_minor')::bigint;
    -- (least() skips nulls, so an unknown tax or fee is kept unknown by hand.)
    if v_currency <> v_program_currency and v_program_currency = 'USD' and v_usd_amount > 0 then
      -- The tax in USD in the same share of the price; the store's cut is what is left
      -- between the price, the tax and the proceeds.
      v_tax := case when v_tax is not null
        then least(round(v_tax::numeric * v_usd_amount / v_amount)::bigint, v_usd_amount) end;
      v_fee := case when v_usd_proceeds is not null
        then greatest(v_usd_amount - least(v_usd_proceeds, v_usd_amount) - coalesce(v_tax, 0), 0) end;
      v_amount := v_usd_amount;
      v_currency := 'USD';
    else
      v_tax := case when v_tax is not null then least(v_tax, v_amount) end;
      v_fee := case when v_fee is not null then least(v_fee, v_amount - coalesce(v_tax, 0)) end;
    end if;

    insert into public.program_sales(program_id, amount_minor, currency, tax_minor, store_fee_minor, paid_at,
        click_id, click_record_id, affiliate_id, match_source, source, store, store_transaction_id,
        store_original_transaction_id, store_product_id, subscription_sequence, first_sale_id)
      values (g.id, v_amount, v_currency, v_tax, v_fee, v_at,
        v_click.click_id, v_click.click_record_id, v_click.affiliate_id, v_click.match_source, c.provider, v_store, v_tx,
        v_original, p->>'product_id', coalesce(v_seq, 1), case when v_seq > 1 then v_first.id end)
      returning id into v_sale;
    perform kma_internal.program_store_resequence(g.id, c.project_id, c.provider, v_original);
    v_outcome := 'sale';
  end if;

  update public.program_store_events e set outcome = v_outcome, sale_id = v_sale,
    retry_after = case when v_outcome in ('unmatched_creator','unmatched_person') and r.received_at > now() - interval '30 days' then now() + interval '5 minutes' end,
    retry_input = case when v_outcome in ('unmatched_creator','unmatched_person') and r.received_at > now() - interval '30 days' then jsonb_build_object(
      'event_id',r.event_id,'provider',c.provider,'type',v_type,'environment',v_env,'store',v_store,'transaction_id',v_tx,
      'original_transaction_id',v_original,'product_id',p->'product_id','purchased_at',p->'purchased_at',
      'amount_minor',p->'amount_minor','tax_minor',p->'tax_minor','store_fee_minor',p->'store_fee_minor','currency',v_currency,'usd',p->'usd') end,
    identity_digests = case when v_outcome in ('unmatched_creator','unmatched_person') and r.received_at > now() - interval '30 days' then coalesce(r.identity_digests,
      array(select encode(extensions.digest(c.project_id::text || ':' || i,'sha256'),'hex') from unnest(v_ids) i)) end,
    refund_details = case when v_outcome = 'ignored_no_sale' then coalesce(r.refund_details, v_details) end where e.id = r.id;
  if v_outcome in ('sale', 'sale_exists') then
    for pending in
      select e.id, e.connection_id, e.refund_details from public.program_store_events e
      join public.program_store_connections sc on sc.id=e.connection_id
      where sc.workspace_id=c.workspace_id and sc.provider=c.provider and e.transaction_id=v_tx
        and e.outcome='ignored_no_sale' and e.refund_details is not null
      order by e.received_at, e.id for update of e
    loop
      perform kma_internal.apply_store_refund(pending.id, v_sale, pending.refund_details);
      update public.program_store_events set outcome='refund', sale_id=v_sale, refund_details=null where id=pending.id;
      update public.program_store_connections set ignored_count=greatest(0,ignored_count-1) where id=pending.connection_id;
    end loop;
  end if;
  update public.program_store_connections x set
      events_count = x.events_count + v_new::int,
      sales_count = x.sales_count + (v_outcome = 'sale')::int,
      ignored_count = greatest(0, x.ignored_count - (not v_new)::int) + (v_outcome like 'ignored\_%' or v_outcome like 'unmatched\_%')::int,
      last_event_at = clock_timestamp()
    where x.id = c.id;

  return jsonb_build_object('received', true, 'duplicate', not v_new, 'outcome', v_outcome, 'sale_id', v_sale,
    'subscription_sequence', (select x.subscription_sequence from public.program_sales x where x.id = v_sale));
end $$;

-- Once approved money is owned by a creator, keep the original attribution and record the later claim.
create table kma_internal.program_attribution_reviews (
  sale_id uuid primary key references public.program_sales(id),
  original_creator uuid, proposed_creator uuid, proposed_source text not null, received_at timestamptz not null default now()
);
revoke all on kma_internal.program_attribution_reviews from public, anon, authenticated;
create function kma_internal.keep_approved_attribution() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.affiliate_id is distinct from old.affiliate_id and exists (
    select 1 from public.program_commissions where sale_id=old.id and approved_at is not null for update
  ) then
    insert into kma_internal.program_attribution_reviews(sale_id, original_creator, proposed_creator, proposed_source)
    values (old.id, old.affiliate_id, new.affiliate_id, new.match_source) on conflict (sale_id) do nothing;
    new.affiliate_id := old.affiliate_id;
    new.click_id := old.click_id;
    new.click_record_id := old.click_record_id;
    new.match_source := old.match_source;
  end if;
  return new;
end $$;
revoke all on function kma_internal.keep_approved_attribution() from public, anon, authenticated;
create trigger preserve_approved_creator before update of affiliate_id on public.program_sales
for each row execute function kma_internal.keep_approved_attribution();

create or replace function public.partner_program_performance(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(false);
  v_days integer;
  v_zone text;
  v_today date;
  v_start date;
  v_from timestamptz;
  v_to timestamptz;
  v_programs public.affiliate_programs[];
  p public.affiliate_programs;
  v_answer jsonb;
begin
  perform kma_internal.program_member_input(p_input, array['slug', 'days']);
  if jsonb_typeof(p_input->'days') is distinct from 'number' or p_input->>'days' not in ('7', '30', '90') then
    perform kma_internal.program_fail('invalid_input', 'days must be 7, 30 or 90');
  end if;
  if p_input ? 'slug' and jsonb_typeof(p_input->'slug') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_input', 'slug must be text');
  end if;
  v_days := (p_input->>'days')::integer;
  v_zone := kma_internal.program_link_timezone(v_affiliate);
  v_today := (now() at time zone v_zone)::date;
  v_start := v_today - (v_days - 1);
  v_from := v_start::timestamp at time zone v_zone;
  v_to := (v_today + 1)::timestamp at time zone v_zone;

  -- Every program the creator is or was an active member of, or has earned in.
  select coalesce(array_agg(q order by q.name, q.id), '{}') into v_programs
  from public.affiliate_programs q
  where exists (select 1 from public.affiliate_program_members m
      where m.program_id = q.id and m.affiliate_id = v_affiliate and m.activated_at is not null)
    or exists (select 1 from public.program_commissions x
      where x.program_id = q.id and x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed'))
    or exists (select 1 from public.program_creator_entries e
      where e.program_id = q.id and e.affiliate_id = v_affiliate);
  if p_input->>'slug' is not null then
    select q.* into p from unnest(v_programs) q where q.slug = p_input->>'slug';
    if p.id is null then
      perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
    end if;
  elsif cardinality(v_programs) > 0 then
    p := v_programs[1];
  end if;

  v_answer := jsonb_build_object(
    'days', v_days, 'timezone', v_zone, 'starts_on', v_start, 'ends_on', v_today,
    'programs', coalesce((select jsonb_agg(kma_internal.program_link_brief(v_programs[n]) order by n)
      from generate_subscripts(v_programs, 1) n), '[]'::jsonb));
  if p.id is null then
    return v_answer || jsonb_build_object(
      'program', null,
      'totals', '{"clicks":0,"sales":0,"events":0,"earnings_minor":0}'::jsonb,
      'previous', '{"clicks":0,"sales":0,"events":0,"earnings_minor":0}'::jsonb,
      'daily', '[]'::jsonb, 'channels', '[]'::jsonb, 'rewards', '[]'::jsonb, 'budget_reached', false,
      'money', null, 'latest', '[]'::jsonb);
  end if;

  return v_answer || jsonb_build_object(
    'program', kma_internal.program_link_brief(p),
    'totals', kma_internal.program_link_totals(p.id, v_affiliate, v_from, v_to),
    'previous', kma_internal.program_link_totals(p.id, v_affiliate,
      (v_start - v_days)::timestamp at time zone v_zone, v_from),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d.day, 'clicks', coalesce(c.clicks, 0),
          'sales', coalesce(s.sales, 0), 'events', coalesce(e.events, 0),
          'earnings_minor', coalesce(s.earnings_minor, 0) + coalesce(e.earnings_minor, 0)) order by d.day)
      from (select g::date as day from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') g) d
      left join (
        select (k.occurred_at at time zone v_zone)::date as day, count(*) as clicks
        from public.clicks k
        join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
        where k.affiliate_id = v_affiliate and k.product_id = p.product_id and not k.is_bot and not exists (select 1 from public.program_promo_code_uses u where u.click_record_id = k.id)
          and k.occurred_at >= v_from and k.occurred_at < v_to
        group by 1) c on c.day = d.day
      left join (
        select (s.paid_at at time zone v_zone)::date as day, count(*) as sales, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_sales s
        join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
        where s.program_id = p.id and s.affiliate_id = v_affiliate and s.paid_at >= v_from and s.paid_at < v_to
        group by 1) s on s.day = d.day
      left join (
        select (w.occurred_at at time zone v_zone)::date as day, count(*) as events, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_reward_awards w
        join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
        where w.program_id = p.id and w.affiliate_id = v_affiliate and w.status = 'earned'
          and w.occurred_at >= v_from and w.occurred_at < v_to
        group by 1) e on e.day = d.day),
    'channels', (
      -- The links that are not archived, then one line for whatever belongs to no such link.
      select coalesce(jsonb_agg(q.line order by q.place), '[]'::jsonb)
      from (
        select r.place, jsonb_build_object('link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'events', coalesce(t.events, 0),
          'earnings_minor', coalesce(t.earnings_minor, 0)) as line
        from kma_internal.program_link_rows(p.id, v_affiliate) r
        left join kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t on t.link_id = r.link_id
        where r.status <> 'archived'
        union all
        select 1000000, jsonb_build_object('link_id', null, 'kind', 'none', 'channel', null, 'name', 'No link',
          'clicks', coalesce(sum(t.clicks), 0)::bigint, 'sales', coalesce(sum(t.sales), 0)::bigint,
          'events', coalesce(sum(t.events), 0)::bigint,
          'earnings_minor', coalesce(sum(t.earnings_minor), 0)::bigint)
        from kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t
        where not exists (select 1 from kma_internal.program_link_rows(p.id, v_affiliate) r
          where r.link_id = t.link_id and r.status <> 'archived')
        having coalesce(sum(t.sales), 0) + coalesce(sum(t.events), 0) > 0) q),
    -- The rewards the program pays now, each with the events of the window that count.
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'amount_minor', r.amount_minor,
          'count', coalesce(e.events, 0), 'earnings_minor', coalesce(e.earnings_minor, 0)) order by r.place)
      from kma_internal.program_link_rewards(p) r
      left join (
        select w.reward_key, count(*) as events, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_reward_awards w
        join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
        where w.program_id = p.id and w.affiliate_id = v_affiliate and w.status = 'earned'
          and w.occurred_at >= v_from and w.occurred_at < v_to
        group by w.reward_key) e on e.reward_key = r.key), '[]'::jsonb),
    'budget_reached', kma_internal.program_link_budget_reached(p),
    'money', kma_internal.program_link_money(p.id, v_affiliate),
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object('paid_at', q.paid_at, 'link_name', q.link_name,
          'amount_minor', q.amount_minor, 'status', q.status, 'kind', q.kind, 'reward_label', q.reward_label)
        order by q.place)
      from (
        -- A sale is placed by when it was paid, a reward by when its event happened.
        select coalesce(s.paid_at, w.occurred_at) as paid_at, coalesce(b.name, 'No link') as link_name,
          x.amount_minor, x.status, case when x.award_id is null then 'sale' else 'reward' end as kind, w.reward_label,
          row_number() over (order by coalesce(s.paid_at, w.occurred_at) desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        left join public.program_sales s on s.id = x.sale_id
        left join public.program_reward_awards w on w.id = x.award_id
        left join public.clicks k on k.id = coalesce(s.click_record_id, w.click_record_id)
        left join public.affiliate_links l on l.id = k.affiliate_link_id
        left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
        where x.program_id = p.id and x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 5) q), '[]'::jsonb));
end $$;

create or replace function kma_internal.program_link_stats(p_program uuid, p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns table (link_id uuid, clicks bigint, sales bigint, earnings_minor bigint, events bigint)
language sql stable set search_path = '' as $$
  select q.link_id, sum(q.clicks)::bigint, sum(q.sales)::bigint, sum(q.earnings_minor)::bigint, sum(q.events)::bigint
  from (
    select k.affiliate_link_id as link_id, count(*) as clicks, 0::bigint as sales, 0::bigint as earnings_minor,
      0::bigint as events
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = p_affiliate and k.product_id = p.product_id and not k.is_bot and not exists (select 1 from public.program_promo_code_uses u where u.click_record_id = k.id)
      and k.occurred_at >= p_from and k.occurred_at < p_to
    join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where p.id = p_program
    group by k.affiliate_link_id
    union all
    select k.affiliate_link_id, 0, count(*), coalesce(sum(x.amount_minor), 0)::bigint, 0
    from public.program_sales s
    join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
    left join public.clicks k on k.id = s.click_record_id
    where s.program_id = p_program and s.affiliate_id = p_affiliate and s.paid_at >= p_from and s.paid_at < p_to
    group by k.affiliate_link_id
    union all
    select k.affiliate_link_id, 0, 0, coalesce(sum(x.amount_minor), 0)::bigint, count(*)
    from public.program_reward_awards w
    join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
    left join public.clicks k on k.id = w.click_record_id
    where w.program_id = p_program and w.affiliate_id = p_affiliate and w.status = 'earned'
      and w.occurred_at >= p_from and w.occurred_at < p_to
    group by k.affiliate_link_id) q
  group by q.link_id
$$;

create or replace function kma_internal.program_link_member_stats(m public.affiliate_program_members,
  out clicks bigint, out last_click_at timestamptz, out sales bigint, out sales_amount_minor bigint,
  out commission_minor bigint, out pending_minor bigint, out events bigint)
language sql stable set search_path = '' as $$
  select c.clicks, c.last_click_at, s.sales, s.sales_amount_minor,
    s.commission_minor + e.commission_minor, s.pending_minor + e.pending_minor, e.events
  from (
    -- Naming the creator lets the clicks index find them.
    select count(*) as clicks, max(k.occurred_at) as last_click_at
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = m.affiliate_id and k.product_id = p.product_id and not k.is_bot and not exists (select 1 from public.program_promo_code_uses u where u.click_record_id = k.id)
    join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where p.id = m.program_id) c
  cross join (
    select count(*) filter (where x.id is null or x.status in ('held', 'approved')) as sales,
      coalesce(sum(s.amount_minor) filter (where x.id is null or x.status in ('held', 'approved')), 0)::bigint
        as sales_amount_minor,
      coalesce(sum(x.amount_minor) filter (where x.status in ('held', 'approved')), 0)::bigint as commission_minor,
      coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor
    from public.program_sales s
    left join public.program_commissions x on x.sale_id = s.id
    where s.program_id = m.program_id and s.affiliate_id = m.affiliate_id) s
  cross join (
    select count(*) as events,
      coalesce(sum(x.amount_minor), 0)::bigint as commission_minor,
      coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor
    from public.program_reward_awards w
    join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
    where w.program_id = m.program_id and w.affiliate_id = m.affiliate_id and w.status = 'earned') e
$$;

create function kma_internal.retry_unmatched_store_sales() returns void language plpgsql set search_path='' as $$
declare pending record;
begin
  for pending in select e.id,e.retry_input,c.header_sha256 from public.program_store_events e
    join public.program_store_connections c on c.id=e.connection_id and c.status='active'
    where e.retry_after <= now() order by e.retry_after,e.id limit 25
  loop
    begin
      perform public.record_program_store_event(pending.retry_input || jsonb_build_object('header_sha256',pending.header_sha256));
    exception when others then
      update public.program_store_events set retry_after=now()+interval '1 hour' where id=pending.id and retry_after is not null;
      raise warning 'Store receipt reconciliation failed for % (%)',pending.id,sqlstate;
    end;
  end loop;
end $$;
revoke all on function kma_internal.retry_unmatched_store_sales() from public,anon,authenticated,service_role;

create or replace function kma_internal.tick_program_sales_schedule() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_schedule kma_internal.program_sales_schedule;
  v_credential text;
  v_request bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-program-sales-scheduler', 0)) then
    return jsonb_build_object('status', 'locked');
  end if;
  update kma_internal.program_sales_schedule set last_tick_at = clock_timestamp() where singleton
    returning * into v_schedule;
  if not v_schedule.enabled then
    return jsonb_build_object('status', 'paused');
  end if;
  -- Nothing waiting: no call. Leased receipts are with a worker already.
  perform kma_internal.retry_unmatched_store_sales();
  if not exists (select 1 from public.merchant_payment_events e
    where e.processed_at is null and e.next_attempt_at <= clock_timestamp()
      and (e.lease_until is null or e.lease_until < clock_timestamp())) then
    return jsonb_build_object('status', 'idle');
  end if;
  select decrypted_secret into v_credential from vault.decrypted_secrets where name = 'kma_program_sales_scheduler';
  if v_credential is null or length(v_credential) < 32 then
    return jsonb_build_object('status', 'credential_missing');
  end if;
  v_request := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-sales-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kma-scheduler-secret', v_credential),
    timeout_milliseconds := 80000);
  update kma_internal.program_sales_schedule
    set last_dispatch_at = clock_timestamp(), last_request_id = v_request where singleton;
  return jsonb_build_object('status', 'dispatched');
end $$;

-- Capture each row as it actually stood under its write lock, including an earlier import.
create table kma_internal.cost_import_previous (
  import_id uuid not null references public.attribution_cost_imports(id) on delete cascade,
  cost_id uuid not null, previous jsonb not null, primary key(import_id,cost_id)
);
revoke all on kma_internal.cost_import_previous from public,anon,authenticated,service_role;
create function kma_internal.remember_imported_cost() returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select 1 from kma_internal.cost_import_previous where import_id=old.import_id and cost_id=old.id and previous->>'import_id'=new.import_id::text) then return new; end if;
  insert into kma_internal.cost_import_previous values(new.import_id,old.id,to_jsonb(old))
  on conflict do nothing;
  return new;
end $$;
revoke all on function kma_internal.remember_imported_cost() from public,anon,authenticated,service_role;
create trigger remember_imported_cost before update on public.attribution_costs for each row
when(new.origin='csv' and new.import_id is distinct from old.import_id)
execute function kma_internal.remember_imported_cost();

create or replace function public.attribution_cost_import_undo(p_project uuid, p_import uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
  restored integer;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  perform pg_advisory_xact_lock(hashtextextended('cost-import:' || p_project::text,0));
  perform 1 from public.attribution_cost_imports where id = p_import and project_id = p_project for update;
  if not found then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  -- Splice this upload out of later uploads' undo histories as well.
  update kma_internal.cost_import_previous child set previous=parent.previous
    from kma_internal.cost_import_previous parent
    where child.previous->>'import_id'=p_import::text and parent.import_id=p_import and child.cost_id=parent.cost_id;
  delete from kma_internal.cost_import_previous where previous->>'import_id'=p_import::text;
  update public.attribution_costs c set amount=p.amount,currency=p.currency,origin=p.origin,import_id=p.import_id,
    created_by=p.created_by,updated_at=clock_timestamp()
  from kma_internal.cost_import_previous b cross join lateral jsonb_populate_record(null::public.attribution_costs,b.previous) p
  where c.id=b.cost_id and c.project_id=p_project and c.import_id=p_import and b.import_id=p_import;
  get diagnostics restored=row_count;
  delete from public.attribution_costs where import_id = p_import and project_id = p_project;
  get diagnostics v_n = row_count;
  delete from public.attribution_cost_imports where id = p_import;
  return jsonb_build_object('deleted', v_n, 'restored', restored);
end $$;

create or replace function public.attribution_cost_import(p_project uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project, 'developer');
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_today date := (now() at time zone p.timezone)::date;
  v_rows jsonb := case when jsonb_typeof(p_input) = 'object' then p_input->'rows' end;
  v_file text;
  v_checked jsonb;
  v_errors jsonb;
  v_import uuid;
  v_replaced integer;
  v_count integer;
begin
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) not between 1 and 5000 then
    raise exception 'Upload 1 to 5,000 rows at a time' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_count := jsonb_array_length(v_rows);
  v_file := nullif(left(btrim(coalesce(p_input->>'file_name', '')), 200), '');

  select jsonb_agg(jsonb_build_object('n', x.ord) || kma_internal.attribution_cost_row(x.value, s.currency, v_today)
      order by x.ord)
  into v_checked
  from jsonb_array_elements(v_rows) with ordinality x(value, ord);

  select coalesce(jsonb_agg(jsonb_build_object('row', e.n, 'message', e.message) order by e.n), '[]'::jsonb)
  into v_errors
  from (
    select c.n, coalesce(c.r->>'error', format('Repeats row %s: same day, source, campaign, ad set and ad', c.first_n)) message
    from (
      select (y->>'n')::integer n, y r,
        min((y->>'n')::integer) over (partition by case when y ? 'error' then null
          else jsonb_build_array(y->'day', y->'source', y->'campaign', y->'adset', y->'ad') end) first_n
      from jsonb_array_elements(v_checked) y
    ) c
    where c.r ? 'error' or c.first_n < c.n
    order by c.n
    limit 50
  ) e;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('imported', 0, 'errors', v_errors);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cost-import:' || p_project::text,0));
  -- clock_timestamp: two uploads in one transaction still list newest first.
  insert into public.attribution_cost_imports(project_id, file_name, rows, created_by, created_at)
  values (p_project, v_file, v_count, auth.uid(), clock_timestamp())
  returning id into v_import;
  select count(*) into v_replaced
  from jsonb_array_elements(v_checked) y
  join public.attribution_costs c on c.project_id = p_project and c.day = (y->>'day')::date and c.source = y->>'source'
    and c.campaign = y->>'campaign' and c.adset = y->>'adset' and c.ad = y->>'ad';
  insert into public.attribution_costs(project_id, day, source, campaign, adset, ad, amount, currency, origin, import_id, created_by)
  select p_project, (y->>'day')::date, y->>'source', y->>'campaign', y->>'adset', y->>'ad', (y->>'amount')::numeric,
    y->>'currency', 'csv', v_import, auth.uid()
  from jsonb_array_elements(v_checked) y
  on conflict (project_id, day, source, campaign, adset, ad) do update
  set amount = excluded.amount, currency = excluded.currency, origin = 'csv', import_id = excluded.import_id,
    updated_at = now();
  return jsonb_build_object('import_id', v_import, 'imported', v_count, 'replaced', v_replaced, 'errors', '[]'::jsonb);
end $$;

create or replace function public.analytics_funnel_report(
  p_project uuid, p_definition jsonb, p_range text, p_breakdown text default 'none'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_steps jsonb := kma_internal.analytics_funnel_steps(p_definition->'steps');
  v_window integer := kma_internal.analytics_funnel_window(p_definition->'window_seconds');
  v_n integer;
  w record;
begin
  if p_breakdown not in ('none', 'country', 'device', 'platform', 'browser', 'source') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(v_steps);
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  return (
    with walk as (
      select * from kma_internal.analytics_funnel_walk(p_project, v_steps, make_interval(secs => v_window), w.from_at, w.to_at)
    ), grouped as (
      select wk.*, kma_internal.analytics_funnel_group(p_breakdown, s) as grp
      from walk wk left join public.analytics_sessions s on s.id = wk.sessions[1]
    ), per_step as (
      select k,
        count(*) filter (where g.reached >= k) as people,
        count(*) filter (where g.reached=k and g.times[1]+make_interval(secs=>v_window) > now()) as pending,
        percentile_cont(0.5) within group (order by extract(epoch from g.times[k] - g.times[k - 1]))
          filter (where k > 1 and g.reached >= k) as median_seconds
      from generate_series(1, v_n) k cross join grouped g
      group by k
    ), top_groups as (
      select grp, count(*) starters from grouped group by grp order by count(*) desc, grp limit 10
    )
    select jsonb_build_object(
      'range', jsonb_build_object('key', p_range, 'from', w.from_at, 'to', w.to_at, 'bucket', w.bucket, 'timezone', v.timezone),
      'window_seconds', v_window,
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object(
          'index', p.k, 'step', v_steps->(p.k - 1), 'people', p.people,
          'from_start', case when first.people > 0 then round(p.people::numeric / first.people, 4) end,
          'from_previous', case when p.k > 1 and prev.people > 0 then round(p.people::numeric / prev.people, 4) end,
          'pending', case when p.k < v_n then p.pending end,
          'dropped', case when p.k < v_n then p.people - coalesce(nxt.people, 0) end,
          'median_seconds', round(p.median_seconds::numeric)
        ) order by p.k)
        from per_step p
        join per_step first on first.k = 1
        left join per_step prev on prev.k = p.k - 1
        left join per_step nxt on nxt.k = p.k + 1), '[]'::jsonb),
      'started', (select count(*) from grouped),
      'converted', (select count(*) from grouped where reached = v_n),
      'series', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', b.bucket_start, 'partial', b.bucket_end > now(),
          'started', (select count(*) from grouped g where g.times[1] >= b.bucket_start and g.times[1] < b.bucket_end),
          'converted', (select count(*) from grouped g where g.reached = v_n and g.times[1] >= b.bucket_start and g.times[1] < b.bucket_end)
        ) order by b.bucket_start)
        from kma_internal.analytics_buckets(p_range, v.timezone) b), '[]'::jsonb),
      'breakdown', case when p_breakdown = 'none' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', t.grp,
          'steps', (select jsonb_agg((select count(*) from grouped g where g.grp = t.grp and g.reached >= k) order by k)
            from generate_series(1, v_n) k)
        ) order by t.starters desc, t.grp)
        from top_groups t), '[]'::jsonb) end,
      'other_groups', case when p_breakdown = 'none' then 0 else
        (select count(distinct grp) from grouped) - (select count(*) from top_groups) end
    )
  );
end $$;

-- Date ranges are inclusive local calendar days in the project's time zone.
create or replace function kma_internal.analytics_window(p_range text, p_timezone text)
returns table (from_at timestamptz, to_at timestamptz, prev_from timestamptz, prev_to timestamptz, bucket text, days integer)
language plpgsql stable set search_path = '' as $$
declare
  first_day date; last_day date; span integer;
  start_at timestamptz;
begin
  if p_range ~ '^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$' then
    first_day := split_part(p_range, '..', 1)::date;
    last_day := split_part(p_range, '..', 2)::date;
    span := last_day - first_day + 1;
    if span not between 1 and 366 then raise exception 'Choose up to 366 consecutive days' using errcode='22023'; end if;
    return query select first_day::timestamp at time zone p_timezone, (last_day+1)::timestamp at time zone p_timezone,
      (first_day-span)::timestamp at time zone p_timezone, first_day::timestamp at time zone p_timezone, 'day'::text, span;
    return;
  end if;
  span := case p_range when 'today' then 1 when '7d' then 7 when '30d' then 30 when '90d' then 90 end;
  if span is null then raise exception 'Choose today, 7d, 30d or 90d' using errcode='22023'; end if;
  start_at := (date_trunc('day', now() at time zone p_timezone)-make_interval(days=>span-1)) at time zone p_timezone;
  return query select start_at, now(), start_at-make_interval(days=>span), now()-make_interval(days=>span),
    case when span=1 then 'hour' else 'day' end, span;
end $$;

create or replace function kma_internal.analytics_buckets(p_range text, p_timezone text)
returns table (bucket_start timestamptz, bucket_end timestamptz) language sql stable set search_path = '' as $$
  select b, b+interval '1 hour' from generate_series(date_trunc('hour', now())-interval '23 hours',date_trunc('hour',now()),interval '1 hour') b
  where p_range='today'
  union all
  select d at time zone p_timezone, (d+interval '1 day') at time zone p_timezone
  from kma_internal.analytics_window(p_range,p_timezone) w
  cross join lateral generate_series(date_trunc('day',w.from_at at time zone p_timezone),
    date_trunc('day',(w.to_at - interval '1 microsecond') at time zone p_timezone),interval '1 day') d
  where p_range<>'today' order by 1
$$;

create or replace function public.attribution_costs(p_project uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_range text;
  v_family text;
  v_from date;
  v_to date;
  v_today date := (now() at time zone p.timezone)::date;
  v_totals jsonb;
  w record;
begin
  if jsonb_typeof(v_input) <> 'object' then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_range := coalesce(nullif(v_input->>'range', ''), '30d');
  if v_range not in ('7d', '30d', '90d') and v_range !~ '^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$' then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  if jsonb_typeof(v_input->'source') = 'string' and btrim(v_input->>'source') <> '' then
    v_family := kma_internal.attribution_source_family(left(v_input->>'source', 100));
  end if;
  select * into w from kma_internal.analytics_window(v_range, p.timezone);
  v_from := (w.from_at at time zone p.timezone)::date;
  v_to := ((w.to_at - interval '1 microsecond') at time zone p.timezone)::date;

  with lines as (
    select x.day, x.currency, x.origin, x.amount
    from kma_internal.attribution_cost_lines(p_project, v_from, v_to) x
    where v_family is null or kma_internal.attribution_source_family(x.source) = v_family
  ), grouped as (
    select g.day, g.currency, g.origin, sum(g.amount) amount, count(*) n from lines g group by 1, 2, 3
  ), converted as (
    select g.origin, g.n, g.amount * kma_internal.attribution_fx_rate(g.currency, s.currency, g.day) amount
    from grouped g
  )
  select jsonb_build_object(
    'cost', round(coalesce(sum(c.amount), 0), 2),
    'typed', round(coalesce(sum(c.amount) filter (where c.origin = 'manual'), 0), 2),
    'uploaded', round(coalesce(sum(c.amount) filter (where c.origin = 'csv'), 0), 2),
    'links', round(coalesce(sum(c.amount) filter (where c.origin in ('link_install', 'link_click')), 0), 2),
    'unconverted', coalesce(sum(c.n) filter (where c.amount is null), 0))
  into v_totals
  from converted c;

  return jsonb_build_object(
    'currency', s.currency,
    'range', v_range,
    'from', v_from,
    'to', v_to,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'day', c.day, 'source', c.source, 'campaign', c.campaign,
          'adset', c.adset, 'ad', c.ad, 'amount', round(c.amount, 2), 'currency', c.currency, 'origin', c.origin,
          'import_id', c.import_id, 'updated_at', c.updated_at)
        order by c.day desc, c.source, c.campaign, c.adset, c.ad)
      from (
        select * from public.attribution_costs x
        where x.project_id = p_project and x.day >= v_from and x.day <= v_to and x.origin in ('manual', 'csv')
          and (v_family is null or kma_internal.attribution_source_family(x.source) = v_family)
        order by x.day desc, x.source, x.campaign, x.adset, x.ad
        limit 1000
      ) c), '[]'::jsonb),
    'link_costs', coalesce((
      select jsonb_agg(jsonb_build_object('day', c.day, 'link_id', c.link_id, 'link_name', c.link_name,
          'source', c.source, 'campaign', c.campaign, 'kind', c.kind, 'count', c.units,
          'amount', round(c.amount, 2), 'currency', c.currency)
        order by c.day desc, c.link_name, c.link_id, c.kind)
      from (
        select x.*, l.name link_name
        from kma_internal.attribution_link_costs(p_project, v_from, v_to) x
        join public.attribution_links l on l.id = x.link_id
        where v_family is null or kma_internal.attribution_source_family(x.source) = v_family
        order by x.day desc, l.name, x.link_id, x.kind
        limit 1000
      ) c), '[]'::jsonb),
    'totals', v_totals,
    'imports', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'rows', i.rows,
          'created_at', i.created_at,
          'remaining', (select count(*) from public.attribution_costs c where c.import_id = i.id))
        order by i.created_at desc, i.id)
      from (
        select * from public.attribution_cost_imports x where x.project_id = p_project
        order by x.created_at desc, x.id limit 20
      ) i), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(kma_internal.attribution_cost_rule_view(r, l) order by l.name, r.created_at, r.id)
      from public.attribution_cost_rules r
      join public.attribution_links l on l.id = r.link_id
      where r.project_id = p_project), '[]'::jsonb),
    -- Names to suggest when typing spend: the source families this project saw in the last 90
    -- days, most seen first. Only names spend can be saved under.
    'sources', coalesce((
      select jsonb_agg(f.family order by f.n desc, f.family)
      from (
        select y.family, count(*) n
        from (
          select kma_internal.attribution_source_family(i.source) family
          from public.attribution_installs i
          where i.project_id = p_project and i.environment = 'production' and i.installed_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(c.source)
          from public.attribution_clicks c
          where c.project_id = p_project and c.clicked_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(coalesce(nullif(btrim(se.utm_source), ''),
            kma_internal.attribution_click_source(se.click_ids)))
          from public.analytics_sessions se
          where se.project_id = p_project and se.environment = 'production' and se.started_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(c.source)
          from public.attribution_costs c
          where c.project_id = p_project and c.day >= v_today - 90
        ) y
        where y.family ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'
        group by y.family
        order by count(*) desc, y.family
        limit 30
      ) f), '[]'::jsonb)
  );
end $$;

create or replace function public.attribution_roi(p_project uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_range text;
  v_group text;
  w record;
  v_from date;
  v_to date;
  fs record;
  fc record;
  fa record;
  v_filters jsonb := '{}'::jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_input) <> 'object' then
    raise exception 'Send the ROI options as an object' using errcode = '22023', detail = 'invalid_input';
  end if;
  if exists (select 1 from jsonb_object_keys(v_input) x where x <> all(array['range', 'group', 'source', 'campaign', 'adset'])) then
    raise exception 'ROI takes a range, a grouping and source, campaign and ad set filters' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_range := coalesce(v_input->>'range', '30d');
  if v_range not in ('7d', '30d', '90d') and v_range !~ '^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$' then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_group := coalesce(v_input->>'group', 'source');
  if v_group not in ('source', 'campaign', 'adset', 'ad', 'day') then
    raise exception 'Group ROI by source, campaign, ad set, ad or day' using errcode = '22023', detail = 'invalid_input';
  end if;
  select * into fs from kma_internal.attribution_filter(v_input, 'source');
  select * into fc from kma_internal.attribution_filter(v_input, 'campaign');
  select * into fa from kma_internal.attribution_filter(v_input, 'adset');
  if v_group = 'campaign' and not fs.given then
    raise exception 'Choose a source to see its campaigns' using errcode = '22023', detail = 'invalid_input';
  elsif v_group = 'adset' and not (fs.given and fc.given) then
    raise exception 'Choose a source and a campaign to see their ad sets' using errcode = '22023', detail = 'invalid_input';
  elsif v_group = 'ad' and not (fs.given and fc.given and fa.given) then
    raise exception 'Choose a source, a campaign and an ad set to see their ads' using errcode = '22023', detail = 'invalid_input';
  end if;
  if fs.given then v_filters := v_filters || jsonb_build_object('source', fs.key); end if;
  if fc.given then v_filters := v_filters || jsonb_build_object('campaign', fc.key); end if;
  if fa.given then v_filters := v_filters || jsonb_build_object('adset', fa.key); end if;

  select * into w from kma_internal.analytics_window(v_range, p.timezone);
  v_from := (w.from_at at time zone p.timezone)::date;
  v_to := ((w.to_at - interval '1 microsecond') at time zone p.timezone)::date;

  with people as materialized (
    select x.*, case v_group
        when 'source' then x.source_key when 'campaign' then x.campaign_key when 'adset' then x.adset_key
        when 'ad' then x.ad_key else to_char((x.acquired_at at time zone p.timezone)::date, 'YYYY-MM-DD') end k
    from kma_internal.attribution_people_value(p_project, s.currency, w.from_at, w.to_at) x
    where (not fs.given or x.source_key is not distinct from fs.key)
      and (not fc.given or x.campaign_key is not distinct from fc.key)
      and (not fa.given or x.adset_key is not distinct from fa.key)
  ), cost_lines as (
    select c.day, c.currency, sum(c.amount) amount, count(*)::integer n, case v_group
        when 'source' then c.source_key when 'campaign' then c.campaign_key when 'adset' then c.adset_key
        when 'ad' then c.ad_key else to_char(c.day, 'YYYY-MM-DD') end k
    from (
      select l.day, l.currency, l.amount, kma_internal.attribution_source_key(l.source) source_key,
        kma_internal.attribution_key(l.campaign) campaign_key, kma_internal.attribution_key(l.adset) adset_key,
        kma_internal.attribution_key(l.ad) ad_key
      from kma_internal.attribution_cost_lines(p_project, v_from, v_to) l
    ) c
    where (not fs.given or c.source_key is not distinct from fs.key)
      and (not fc.given or c.campaign_key is not distinct from fc.key)
      and (not fa.given or c.adset_key is not distinct from fa.key)
    group by 1, 2, 5
  ), cost_rates as materialized (
    select x.day, x.currency, kma_internal.attribution_fx_rate(x.currency, s.currency, x.day) rate
    from (select distinct cl.day, cl.currency from cost_lines cl) x
  ), costs as (
    -- cost is null when the currency had no rate that day: left out, and counted.
    select cl.k, cl.currency, cl.n, cl.amount * r.rate cost
    from cost_lines cl join cost_rates r on r.day = cl.day and r.currency = cl.currency
  ), facts as (
    -- One line per person, per day a person paid on, per cost, and (by day) per day of the
    -- range, added up by key below. Every person is in exactly one group.
    select pp.k, 1 users, case when pp.installed then 1 else 0 end installs, case when pp.revenue > 0 then 1 else 0 end payers,
      pp.revenue, 0::numeric d0, 0::numeric d7, 0::numeric d30, 0::numeric cost
    from people pp
    union all
    select pp.k, 0, 0, 0, 0, case when u.day_index <= 0 then u.amount else 0 end, case when u.day_index <= 7 then u.amount else 0 end,
      case when u.day_index <= 30 then u.amount else 0 end, 0
    from people pp cross join lateral unnest(pp.revenue_days, pp.revenue_amounts) u(day_index, amount)
    union all
    select c.k, 0, 0, 0, 0, 0, 0, 0, c.cost from costs c where c.cost is not null
    union all
    select to_char(d, 'YYYY-MM-DD'), 0, 0, 0, 0, 0, 0, 0, 0
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d where v_group = 'day'
  ), grouped as (
    select f.k, sum(f.users) users, sum(f.installs) installs, sum(f.cost) cost, sum(f.payers) payers, sum(f.revenue) revenue,
      sum(f.d0) d0, sum(f.d7) d7, sum(f.d30) d30
    from facts f group by f.k
  ), shown as (
    select g.*, row_number() over (order by case when v_group = 'day' then g.k end,
      g.k is null, g.cost desc, g.users desc, g.k) position
    from grouped g
  )
  select jsonb_build_object(
    'currency', s.currency, 'range', v_range, 'from', v_from, 'to', v_to, 'timezone', p.timezone,
    'group', v_group, 'filters', v_filters,
    -- Day n is complete for a person once n + 1 whole days have passed since they were acquired.
    'complete', (select jsonb_build_object(
        'd0', coalesce(bool_and(pp.acquired_at + interval '24 hours' <= now()), true),
        'd7', coalesce(bool_and(pp.acquired_at + interval '192 hours' <= now()), true),
        'd30', coalesce(bool_and(pp.acquired_at + interval '744 hours' <= now()), true))
      from people pp),
    'totals', (select kma_internal.attribution_roi_metrics(sum(g.users)::bigint, sum(g.installs)::bigint, sum(g.cost),
        sum(g.payers)::bigint, sum(g.revenue), sum(g.d0), sum(g.d7), sum(g.d30)) from grouped g),
    'rows', coalesce((select jsonb_agg(kma_internal.attribution_roi_metrics(sh.users, sh.installs, sh.cost, sh.payers,
        sh.revenue, sh.d0, sh.d7, sh.d30) || jsonb_build_object('key', sh.k) order by sh.position)
      from shown sh where v_group = 'day' or sh.position <= 200), '[]'::jsonb),
    'unconverted', jsonb_build_object(
      'revenue', (select coalesce(sum(pp.unconverted), 0) from people pp),
      'cost', (select coalesce(sum(c.n), 0) from costs c where c.cost is null),
      'currencies', coalesce((select jsonb_agg(x.c order by x.c) from (
        select unnest(pp.unconverted_currencies) c from people pp
        union select c.currency from costs c where c.cost is null) x), '[]'::jsonb)),
    'has_costs', exists (select 1 from public.attribution_costs c where c.project_id = p_project)
      or exists (select 1 from public.attribution_cost_rules r where r.project_id = p_project),
    'has_revenue', exists (select 1 from public.attribution_revenue r where r.project_id = p_project and r.environment = 'production')
  ) into v_result;
  return v_result;
end $$;
-- Each project chooses one advertiser per network. The database only returns credentials to
-- the worker that holds the current lease. Manual and CSV rows have priority over synced spend.
create table kma_internal.ad_spend_accounts (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  provider text not null check (provider in ('meta','tiktok')),
  account_id text not null check (account_id ~ '^[0-9]{1,40}$'),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  secret_id uuid not null,
  enabled boolean not null default true,
  lease_id uuid, lease_expires timestamptz, from_day date, through_day date,
  next_run timestamptz not null default now(), last_success timestamptz, last_error text,
  primary key(project_id,provider)
);
revoke all on kma_internal.ad_spend_accounts from public, anon, authenticated, service_role;

create function public.ad_spend_accounts(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform kma_internal.analytics_require_project(p_project);
 return coalesce((select jsonb_agg(jsonb_build_object('provider',provider,'account_id',account_id,'currency',currency,'enabled',enabled,'last_success',last_success,'last_error',last_error) order by provider)
    from kma_internal.ad_spend_accounts where project_id=p_project),'[]'::jsonb);
end $$;

create function public.ad_spend_connect(p_project uuid,p_provider text,p_account text,p_currency text,p_token text) returns void
language plpgsql security definer set search_path='' as $$
declare prior kma_internal.ad_spend_accounts; secret uuid;
begin
 perform kma_internal.analytics_require_project(p_project,'admin');
 if p_provider is null or p_provider not in ('meta','tiktok') or p_account is null or p_account !~ '^[0-9]{1,40}$'
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' or coalesce(length(trim(p_token)),0) not between 10 and 8192 then
    raise exception 'Check the advertiser ID, currency and access token' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_project::text||p_provider,0));
 select * into prior from kma_internal.ad_spend_accounts where project_id=p_project and provider=p_provider for update;
 if found then
   if prior.account_id<>p_account or prior.currency<>p_currency then
     raise exception 'Use the original advertiser and billing currency to preserve the spend history' using errcode='22023';
   end if;
   perform vault.update_secret(prior.secret_id,trim(p_token));
   update kma_internal.ad_spend_accounts set enabled=true,lease_id=null,lease_expires=null,next_run=now(),last_error=null where project_id=p_project and provider=p_provider;
 else
   select vault.create_secret(trim(p_token)) into secret;
   insert into kma_internal.ad_spend_accounts(project_id,provider,account_id,currency,secret_id) values(p_project,p_provider,p_account,p_currency,secret);
 end if;
end $$;

create function public.ad_spend_disconnect(p_project uuid,p_provider text) returns void
language plpgsql security definer set search_path='' as $$
declare secret uuid;
begin
 perform kma_internal.analytics_require_project(p_project,'admin');
 update kma_internal.ad_spend_accounts set enabled=false,lease_id=null,lease_expires=null,last_error=null where project_id=p_project and provider=p_provider returning secret_id into secret;
 if found then perform vault.update_secret(secret,'disconnected'); end if;
end $$;

create function public.ad_spend_claim() returns jsonb language sql volatile security definer set search_path='' as $$
 with due as (
   select a.project_id,a.provider,(now() at time zone p.timezone)::date as today from kma_internal.ad_spend_accounts a
   join public.analytics_projects p on p.id=a.project_id where a.enabled and a.next_run<=now() and coalesce(a.lease_expires,'-infinity')<now()
   order by a.next_run,a.project_id,a.provider limit 4 for update of a skip locked
 ), claimed as (
   update kma_internal.ad_spend_accounts a set lease_id=gen_random_uuid(),lease_expires=now()+interval '5 minutes',from_day=d.today-7,through_day=d.today-1
   from due d where a.project_id=d.project_id and a.provider=d.provider returning a.*
 ) select coalesce(jsonb_agg(jsonb_build_object('project_id',c.project_id,'provider',c.provider,'account_id',c.account_id,'currency',c.currency,
   'lease_id',c.lease_id,'from_day',c.from_day,'through_day',c.through_day,'credential',s.decrypted_secret)), '[]'::jsonb)
   from claimed c join vault.decrypted_secrets s on s.id=c.secret_id
$$;

create function public.ad_spend_complete(p_project uuid,p_provider text,p_lease uuid,p_rows jsonb,p_error text) returns void
language plpgsql security definer set search_path='' as $$
declare a kma_internal.ad_spend_accounts;
begin
 select * into a from kma_internal.ad_spend_accounts where project_id=p_project and provider=p_provider and enabled and lease_id=p_lease for update;
 if not found then return; end if;
 if p_error is not null then
   update kma_internal.ad_spend_accounts set last_error=left(p_error,60),lease_id=null,lease_expires=null,next_run=now()+interval '1 hour' where project_id=p_project and provider=p_provider;
   return;
 end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100000 then raise exception 'invalid_report'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) r(day date,campaign text,amount numeric)
    where r.day is null or r.day not between a.from_day and a.through_day or coalesce(length(r.campaign),0) not between 1 and 200 or r.amount is null or r.amount<0) then raise exception 'invalid_report'; end if;
 delete from public.attribution_costs where project_id=p_project and origin=p_provider and day between a.from_day and a.through_day;
 insert into public.attribution_costs(project_id,day,source,campaign,amount,currency,origin)
   select p_project,r.day,p_provider,r.campaign,r.amount,a.currency,p_provider from jsonb_to_recordset(p_rows) r(day date,campaign text,amount numeric)
   on conflict(project_id,day,source,campaign,adset,ad) do nothing;
 update kma_internal.ad_spend_accounts set last_success=now(),last_error=null,lease_id=null,lease_expires=null,next_run=now()+interval '12 hours' where project_id=p_project and provider=p_provider;
end $$;
revoke all on function public.ad_spend_accounts(uuid),public.ad_spend_connect(uuid,text,text,text,text),public.ad_spend_disconnect(uuid,text),public.ad_spend_claim(),public.ad_spend_complete(uuid,text,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.ad_spend_accounts(uuid),public.ad_spend_connect(uuid,text,text,text,text),public.ad_spend_disconnect(uuid,text) to authenticated;
grant execute on function public.ad_spend_claim(),public.ad_spend_complete(uuid,text,uuid,jsonb,text) to service_role;
create function kma_internal.ad_spend_forget_token() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform vault.update_secret(old.secret_id,'disconnected'); return old; end $$;
revoke all on function kma_internal.ad_spend_forget_token() from public,anon,authenticated,service_role;
create trigger forget_advertiser_credential after delete on kma_internal.ad_spend_accounts for each row execute function kma_internal.ad_spend_forget_token();
create function public.workspace_creator_directory(p_workspace uuid,p_search text,p_status text,p_after uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare role_name text:=kma_internal.analytics_require_workspace(p_workspace);
  program public.affiliate_programs:=kma_internal.program_of(p_workspace);
begin
 if length(coalesce(p_search,''))>160 or p_status not in ('all','pending','active','ended') then raise exception 'Invalid creator filter' using errcode='22023'; end if;
 return (with page as materialized (
   select m.* from public.affiliate_program_members m join public.affiliates a on a.id=m.affiliate_id
   where m.program_id=program.id and (p_after is null or m.id>p_after)
     and (p_status='all' or m.status=p_status or (p_status='ended' and m.status in ('removed','declined','left')))
     and (coalesce(trim(p_search),'')='' or position(lower(trim(p_search)) in lower(concat_ws(' ',a.public_name,a.slug)))>0)
   order by m.id limit 51), visible as (select * from page order by id limit 50)
   select jsonb_build_object('rows',coalesce((select jsonb_agg(kma_internal.program_creator_json(v::public.affiliate_program_members) order by v.id) from visible v),'[]'::jsonb),
     'next',case when (select count(*) from page)>50 then (select id from visible order by id desc limit 1) end));
end $$;

create function public.partner_program_statement(p_kind text,p_before_at timestamptz,p_before_id uuid,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare affiliate uuid:=public.current_partner_affiliate_id(true);
begin
 if p_kind not in ('ledger','commissions','payouts') or p_until is null or (p_before_id is null)<>(p_before_at is null) then raise exception 'Invalid statement filter' using errcode='22023'; end if;
 return (with history as (
   select e.id,e.created_at at_time,e.kind label,p.name program,e.amount_minor,e.currency,coalesce(e.payout_id,e.commission_id,e.id) reference
   from public.program_creator_entries e join public.affiliate_programs p on p.id=e.program_id where p_kind='ledger' and e.affiliate_id=affiliate
   union all
   select c.id,c.created_at,c.status,p.name,c.amount_minor,c.currency,coalesce(c.sale_id,c.award_id,c.id)
   from public.program_commissions c join public.affiliate_programs p on p.id=c.program_id where p_kind='commissions' and c.affiliate_id=affiliate
   union all
   select o.id,o.created_at,o.status,null::text,o.amount_minor,o.currency,o.id from public.program_payouts o where p_kind='payouts' and o.affiliate_id=affiliate
 ), page as materialized (
   select * from history where at_time<=p_until and (p_before_at is null or (at_time,id)<(p_before_at,p_before_id))
   order by at_time desc,id desc limit 101
 ), visible as(select * from page order by at_time desc,id desc limit 100)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v) order by v.at_time desc,v.id desc) from visible v),'[]'::jsonb),
 'more',(select count(*)>100 from page)));
end $$;

revoke all on function public.workspace_creator_directory(uuid,text,text,uuid),public.partner_program_statement(text,timestamptz,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.workspace_creator_directory(uuid,text,text,uuid),public.partner_program_statement(text,timestamptz,uuid,timestamptz) to authenticated;
create table kma_internal.program_notices (
 id uuid primary key default gen_random_uuid(), workspace_id uuid references public.analytics_workspaces(id) on delete cascade,
 affiliate_id uuid references public.affiliates(id) on delete cascade, reference uuid not null, action text, label text not null, created_at timestamptz not null default now()
);
create index program_notices_workspace on kma_internal.program_notices(workspace_id,created_at desc,id desc) where workspace_id is not null;
create index program_notices_creator on kma_internal.program_notices(affiliate_id,created_at desc,id desc) where affiliate_id is not null;
revoke all on kma_internal.program_notices from public,anon,authenticated,service_role;
create function kma_internal.program_notice_change() returns trigger language plpgsql security definer set search_path='' as $$
declare w uuid; creator uuid; title text; name text;
begin
 if tg_table_name='affiliate_program_members' then
   select p.workspace_id,p.name into w,name from public.affiliate_programs p where p.id=new.program_id;
   creator:=new.affiliate_id;
   title:=coalesce(name,'Program')||' · Creator membership '||new.status;
 elsif tg_table_name='affiliate_programs' then
   w:=new.workspace_id;title:=coalesce(new.name,'Program')||' · '||replace(new.status,'_',' ')||case when new.pause_reason is not null and new.status='paused' then ' ('||replace(new.pause_reason,'_',' ')||')' else '' end;
 elsif tg_table_name='program_payouts' then
   creator:=new.affiliate_id;title:='Payout · '||case when new.status='paid' then 'Transferred to Stripe' else new.status end;
 else
   select p.workspace_id,p.name into w,name from public.affiliate_programs p where p.id=new.program_id;
   creator:=new.affiliate_id;title:=coalesce(name,'Program')||' · Refund recorded';
 end if;
 insert into kma_internal.program_notices(workspace_id,affiliate_id,reference,label,action) values(w,creator,new.id,title,
   case tg_table_name when 'affiliate_program_members' then 'membership' when 'affiliate_programs' then 'program' when 'program_payouts' then 'earnings' else 'refund' end);
 return new;
end $$;
revoke all on function kma_internal.program_notice_change() from public,anon,authenticated,service_role;
create trigger membership_notice_insert after insert on public.affiliate_program_members for each row execute function kma_internal.program_notice_change();
create trigger membership_notice_update after update of status on public.affiliate_program_members for each row when(old.status is distinct from new.status) execute function kma_internal.program_notice_change();
create trigger merchant_program_notice after update of status on public.affiliate_programs for each row when(old.status is distinct from new.status) execute function kma_internal.program_notice_change();
create trigger creator_payout_notice_insert after insert on public.program_payouts for each row execute function kma_internal.program_notice_change();
create trigger creator_payout_notice after update of status on public.program_payouts for each row when(old.status is distinct from new.status) execute function kma_internal.program_notice_change();
create trigger program_refund_notice after update of refunded_minor on public.program_sales for each row when(new.refunded_minor>old.refunded_minor) execute function kma_internal.program_notice_change();

create function public.program_activity_page(p_workspace uuid,p_before_at timestamptz,p_before_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare creator uuid;
begin
 if p_workspace is not null then perform kma_internal.analytics_require_workspace(p_workspace); else creator:=public.current_partner_affiliate_id(true); end if;
 return (with page as materialized(select n.id,n.created_at,n.label,n.reference,n.action from kma_internal.program_notices n
  where ((p_workspace is not null and n.workspace_id=p_workspace) or (p_workspace is null and n.affiliate_id=creator))
    and (p_before_at is null or (n.created_at,n.id)<(p_before_at,p_before_id)) order by n.created_at desc,n.id desc limit 51),
  visible as(select * from page order by created_at desc,id desc limit 50)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc) from visible v),'[]'::jsonb),'more',(select count(*)>50 from page)));
end $$;

-- Scope unresolved provider receipts to their original workspace. Only display the transaction
-- reference and settlement outcome. Raw receipt contents and identity digests stay internal.
create function public.program_reconciliation_page(p_workspace uuid,p_kind text,p_search text,p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_workspace is null then perform public.assert_admin_password(array['owner','operations']::text[],'review affiliate programs');
 else perform kma_internal.analytics_require_workspace(p_workspace,'admin'); end if;
 if p_kind not in ('exceptions','history') or length(coalesce(p_search,''))>200 or (p_kind='history' and p_workspace is not null) then raise exception 'Invalid review filter' using errcode='22023';end if;
 return (with entries as (
  select e.id,e.received_at created_at,coalesce(p.name,c.provider) program,c.provider||' · '||replace(e.outcome,'_',' ') label,
    coalesce(e.transaction_id,e.event_id) reference
  from public.program_store_events e join public.program_store_connections c on c.id=e.connection_id left join public.affiliate_programs p on p.workspace_id=c.workspace_id
  where p_kind='exceptions' and (p_workspace is null or c.workspace_id=p_workspace) and (e.outcome in ('unmatched_person','unmatched_program','unmatched_creator') or e.outcome='ignored_no_sale' and e.type='refund')
  union all
  select s.id,r.received_at,p.name,'Approved commission held with original creator',coalesce(s.store_transaction_id,s.payment_intent_id,s.id::text)
  from kma_internal.program_attribution_reviews r join public.program_sales s on s.id=r.sale_id join public.affiliate_programs p on p.id=s.program_id
  where p_kind='exceptions' and (p_workspace is null or p.workspace_id=p_workspace)
  union all
  select e.id,e.created_at,p.name,case e.action when 'affiliate_program_approved' then 'Approved' else 'Changes requested' end,p.slug
  from public.audit_logs e join public.affiliate_programs p on p.id=e.target_id
  where p_kind='history' and e.target_table='affiliate_programs' and e.action in ('affiliate_program_approved','affiliate_program_changes_requested')
  union all
  select c.id,c.created_at,p.name,'Unfunded commission · '||replace(c.reason,'_',' '),coalesce(s.store_transaction_id,s.payment_intent_id,s.id::text,c.id::text)
  from public.program_commissions c join public.affiliate_programs p on p.id=c.program_id left join public.program_sales s on s.id=c.sale_id
  where p_kind='exceptions' and (p_workspace is null or p.workspace_id=p_workspace) and c.status='not_earned' and c.reason in ('balance_empty','program_paused')
 ), page as materialized(select * from entries e where (p_before_at is null or (e.created_at,e.id)<(p_before_at,p_before_id))
   and (coalesce(trim(p_search),'')='' or position(lower(trim(p_search)) in lower(concat_ws(' ',e.program,e.label,e.reference)))>0)
   order by e.created_at desc,e.id desc limit 51), visible as(select * from page order by created_at desc,id desc limit 50)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc) from visible v),'[]'::jsonb),'more',(select count(*)>50 from page)));
end $$;
revoke all on function public.program_activity_page(uuid,timestamptz,uuid), public.program_reconciliation_page(uuid,text,text,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.program_activity_page(uuid,timestamptz,uuid),public.program_reconciliation_page(uuid,text,text,timestamptz,uuid) to authenticated;
create function public.workspace_program_readiness(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r text:=kma_internal.analytics_require_workspace(p_workspace);
 p public.affiliate_programs:=kma_internal.program_of(p_workspace); b public.program_balance_accounts;
begin
 select * into b from public.program_balance_accounts where program_id=p.id;
 return jsonb_build_object('status',p.status,'published',coalesce(p.live_terms_version,0)>0,'slug',p.slug,'destination',p.landing_url,'payment_mode',p.payment_mode,
  'stripe_connected',kma_internal.workspace_stripe_connection(p_workspace) is not null,
  'available_minor',b.available_minor,'currency',coalesce(b.currency,p.currency,'USD'),'payouts_enabled',kma_internal.program_payouts_enabled(),
  'last_click',(select max(c.occurred_at) from public.clicks c join public.affiliate_links l on l.id=c.affiliate_link_id
    where not c.is_bot and l.product_id=p.product_id and coalesce(l.tracking_environment,'live')='live' and not exists(select from public.program_promo_code_uses u where u.click_record_id=c.id)),
  'last_sale',(select max(s.paid_at) from public.program_sales s where s.program_id=p.id and s.affiliate_id is not null),
  'events',coalesce((select jsonb_agg(jsonb_build_object('key',rule->>'key','label',rule->>'label',
   'test_at',(select max(e.received_at) from public.analytics_events e join public.analytics_projects pr on pr.id=e.project_id where pr.workspace_id=p_workspace and e.name=rule->>'key' and e.environment='development'),
   'live_at',(select max(e.received_at) from public.analytics_events e join public.analytics_projects pr on pr.id=e.project_id where pr.workspace_id=p_workspace and e.name=rule->>'key' and e.environment='production'),
   'awarded_at',(select max(a.occurred_at) from public.program_reward_awards a where a.program_id=p.id and a.reward_key=rule->>'key' and a.status='earned')
   )) from jsonb_array_elements(coalesce(p.rewards,'[]'::jsonb)) rule),'[]'::jsonb));
end $$;
revoke all on function public.workspace_program_readiness(uuid) from public,anon,authenticated,service_role;
grant execute on function public.workspace_program_readiness(uuid) to authenticated;

create function kma_internal.program_low_balance_notice() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into kma_internal.program_notices(workspace_id,reference,label,action) values(new.workspace_id,new.program_id,'Program balance fell below its funding threshold.','balance');
 return new;
end $$;
revoke all on function kma_internal.program_low_balance_notice() from public,anon,authenticated,service_role;
create trigger low_balance_notice after update of available_minor on public.program_balance_accounts
for each row when(new.available_minor<new.min_balance_minor and old.available_minor>=new.min_balance_minor) execute function kma_internal.program_low_balance_notice();

commit;

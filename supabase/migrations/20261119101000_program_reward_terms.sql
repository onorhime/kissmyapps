-- Affiliate self-serve, Phase 6: the program form and terms of a program that pays per event.
--
-- A program earns creators money from sales, from events, or from both (earn_from). A
-- program that pays for events lists up to five rewards (an event name, the words creators
-- read, an amount) and has a monthly budget for them. This file grows the functions of
-- Phases 2 to 4 that save, check, describe and show a program so they know about that:
-- the form (workspace_program_save), the terms snapshot and the agreement generated from
-- it, the merchant's ProgramState, the card creators and the marketplace read, the admin
-- review, and the one rule a sale needs (a program that pays for events only earns nothing
-- on a sale). Judging events and paying rewards is not here.
--
-- For a program that pays for sales only, the generated agreement is byte for byte what it
-- was before this file, so the hash creators accepted does not change. Terms published
-- before this file have no earn_from and no rewards: they are read as 'sales' and [].
--
-- The budget is not part of the terms: the merchant changes it without creators accepting
-- anything. The rewards are: publishing a changed list writes a new terms version.
--
-- New failure codes of workspace_program_save, all SQLSTATE 22023 with the code as DETAIL:
--   invalid_earn_from, invalid_rewards, invalid_reward_budget_minor, events_unavailable.
begin;

-- Reading terms --------------------------------------------------------------------------

-- What a terms snapshot says creators earn from. Terms from before Phase 6 do not say: sales.
create function kma_internal.program_terms_earn_from(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when p_terms->>'earn_from' in ('events', 'both') then p_terms->>'earn_from' else 'sales' end
$$;

-- The rewards of a terms snapshot: [] for a program that pays for sales only, and for
-- terms from before Phase 6.
create function kma_internal.program_terms_rewards(p_terms jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when p_terms->>'earn_from' in ('events', 'both') and jsonb_typeof(p_terms->'rewards') = 'array'
    then p_terms->'rewards' else '[]'::jsonb end
$$;

-- The agreement --------------------------------------------------------------------------

-- The one line that says what creators earn: "30% of every payment" for sales,
-- "$2.00 per Account created, $5.00 per Trial started" for events, and
-- "30% of every payment, plus rewards" for both.
create or replace function kma_internal.program_commission_headline(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case kma_internal.program_terms_earn_from(p_terms)
    when 'events' then r.rewards
    when 'both' then s.sales || ', plus rewards'
    else s.sales
  end
  from (
    select case p_terms->>'commission_type'
        when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of '
        else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, p_terms->>'currency') || ' on '
      end
      || case p_terms->>'commission_duration'
        when 'first_payment' then 'the first payment'
        when 'months' then 'every payment for ' || kma_internal.program_count((p_terms->>'commission_months')::integer, 'month')
        else 'every payment'
      end
      as sales) s
  cross join (
    select string_agg(kma_internal.program_money((x.reward->>'amount_minor')::bigint, p_terms->>'currency')
      || ' per ' || (x.reward->>'label'), ', ' order by x.place) as rewards
    from jsonb_array_elements(kma_internal.program_terms_rewards(p_terms)) with ordinality x(reward, place)) r
$$;

-- Adds a section to a document, numbered after the ones it already has. A paragraph that
-- is null is left out.
create function kma_internal.program_section_add(p_sections jsonb, p_heading text, variadic p_paragraphs text[])
returns jsonb language sql immutable set search_path = '' as $$
  select p_sections || jsonb_build_array(kma_internal.program_section(
    (jsonb_array_length(p_sections) + 1) || '. ' || p_heading, variadic array_remove(p_paragraphs, null)))
$$;

-- The agreement of a program that pays for events, or for sales and events. Generated from
-- the terms snapshot and nothing else, like the sales agreement: no dates, no lookups, no
-- budget (the merchant can change that without a new version).
create function kma_internal.program_agreement_rewards(p_terms jsonb) returns jsonb
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
  -- What the creator is paid, as it reads inside a sentence and at the start of one.
  v_earnings text;
  v_earnings_first text;
  v_amount text;
  v_minimum_text text;
  v_window text;
  v_names text;
  v_reward_lines text[];
  v_summary jsonb;
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

  s := kma_internal.program_section_add(s, 'Who this agreement is between',
    format('This agreement is between you, the creator, and %s. KissMyApps is the platform the program runs on. '
      || 'It tracks what people do after they open your link and pays your %s on behalf of %s.',
      case when v_brand = v_program then v_brand else format('%s, the business behind %s', v_brand, v_program) end,
      v_earnings, v_brand),
    format('You sign this agreement by accepting it on KissMyApps. %s agreed to these terms when it published them, '
      || 'so nobody needs to countersign.', v_brand));
  s := kma_internal.program_section_add(s, 'What you promote',
    format('You promote %s. KissMyApps gives you your own link, and people who click it land on %s.', v_program, v_url),
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
      kma_internal.program_commission_headline(p_terms || '{"earn_from":"sales"}'::jsonb))) || v_summary;
  end if;
  return jsonb_build_object(
    'title', v_program || ' Affiliate Agreement',
    'brand_name', v_brand,
    'program_name', v_program,
    'summary', v_summary,
    'sections', s,
    'extra_terms', v_extra);
end $$;

-- The agreement a creator accepts, generated from a terms snapshot and nothing else. A
-- program that pays for events has its own document (above). Everything after that first
-- step is the Phase 2 text, word for word: sales-only terms must keep giving the document,
-- and so the hash, that creators already accepted.
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
  v_amount text;
  v_minimum_text text;
  v_window text;
  v_names text;
  v_cleared text;
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

  v_sections := jsonb_build_array(
    kma_internal.program_section('1. Who this agreement is between',
      format('This agreement is between you, the creator, and %s. KissMyApps is the platform the program runs on. '
        || 'It tracks sales and pays commission on behalf of %s.',
        case when v_brand = v_program then v_brand else format('%s, the business behind %s', v_brand, v_program) end, v_brand),
      format('You sign this agreement by accepting it on KissMyApps. %s agreed to these terms when it published them, '
        || 'so nobody needs to countersign.', v_brand)),
    kma_internal.program_section('2. What you promote',
      format('You promote %s. KissMyApps gives you your own link, and people who click it land on %s.', v_program, v_url),
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
    kma_internal.program_section('4. How a sale is credited to you',
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.'),
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
      jsonb_build_object('label', 'Commission', 'value', kma_internal.program_commission_headline(p_terms)),
      jsonb_build_object('label', 'Attribution window', 'value', v_window),
      jsonb_build_object('label', 'Hold before payout', 'value',
        case when v_hold > 0 then kma_internal.program_count(v_hold, 'day') else 'None' end),
      jsonb_build_object('label', 'Minimum payout', 'value', case when v_minimum > 0 then v_minimum_text else 'None' end)),
    'sections', v_sections,
    'extra_terms', v_extra);
end $$;

-- Reading a program ------------------------------------------------------------------------

-- The commercial snapshot the agreement is generated from, or null while the form does not
-- have what its earn_from needs: a commission for sales, at least one reward and a budget
-- for events. A program that pays for events only has no commission in its terms; one that
-- pays for sales only has no rewards, whatever the form still holds.
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
  from (select p.earn_from <> 'events' as sales, p.earn_from <> 'sales' as events) e
  where p.name is not null and p.landing_url is not null
    and (not e.sales or (p.commission_type is not null and p.commission_duration is not null))
    and (not e.events or (jsonb_array_length(p.rewards) > 0 and p.reward_budget_minor is not null))
$$;

-- Everything that is worked out from a program rather than stored on it. `commission` is
-- the checklist item "what creators earn": true when everything the chosen earn_from needs
-- is filled in.
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
begin
  stripe_connected := kma_internal.workspace_stripe_connection(p.workspace_id) is not null;
  details := p.name is not null and p.category is not null and p.tagline is not null;
  landing_page := p.landing_url is not null;
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
      or terms->'rewards' is distinct from kma_internal.program_terms_rewards(v_live.terms))));
end $$;

-- The `program` object of ProgramState. The rewards and the budget are the form's own:
-- they stay there while the program pays for sales only.
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
  from kma_internal.program_check(p) c
$$;

-- What every merchant function returns. events_available: a program can pay for events
-- (program money is switched on).
create or replace function kma_internal.program_state(p_workspace uuid, p_role text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.affiliate_programs := kma_internal.program_of(p_workspace);
  c record;
  v_connection jsonb := kma_internal.workspace_stripe_connection(p_workspace);
  v_checklist jsonb;
begin
  if p.id is null then
    return jsonb_build_object(
      'can_manage', p_role in ('owner', 'admin'),
      'stripe_connected', v_connection is not null,
      'brand_name', v_connection->>'business_name',
      'events_available', kma_internal.program_money_enabled(),
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
    'brand_name', v_connection->>'business_name',
    'events_available', kma_internal.program_money_enabled(),
    'program', kma_internal.program_json(p),
    'checklist', v_checklist,
    -- A first listing can be sent for review; a published program only has something to
    -- publish when its terms changed.
    'can_submit', c.stripe_connected and c.complete and c.agreement_read
      and (p.status in ('draft', 'changes_requested') or c.has_unpublished_changes));
end $$;

-- kma_internal.program_review_json (the admin review) is program_json and more, so it
-- shows earn_from, the rewards and the budget without being written again.

-- Changing a program ---------------------------------------------------------------------

-- The rewards from the form. Absent: unchanged. Null or []: none. Otherwise the whole
-- list, at most five, each item exactly {key, label, amount_minor}: an analytics event
-- name, the words creators read (1 to 40 characters, one line) and an amount. No event and
-- no label twice. Returns the list as it is stored, labels trimmed.
create function kma_internal.program_input_rewards(p_input jsonb, p_current jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_list jsonb := p_input->'rewards';
  v_item jsonb;
  v_label text;
  v_rewards jsonb := '[]'::jsonb;
begin
  if not p_input ? 'rewards' then
    return p_current;
  end if;
  if jsonb_typeof(v_list) = 'null' then
    return v_rewards;
  end if;
  if jsonb_typeof(v_list) <> 'array' then
    perform kma_internal.program_fail('invalid_rewards', 'rewards must be a list');
  end if;
  if jsonb_array_length(v_list) > 5 then
    perform kma_internal.program_fail('invalid_rewards', 'A program can have up to five rewards');
  end if;
  for v_item in select x.item from jsonb_array_elements(v_list) with ordinality x(item, place) order by x.place loop
    if jsonb_typeof(v_item) <> 'object'
      or (select count(*) from jsonb_object_keys(v_item)) <> 3
      or jsonb_typeof(v_item->'key') is distinct from 'string'
      or jsonb_typeof(v_item->'label') is distinct from 'string'
      or jsonb_typeof(v_item->'amount_minor') is distinct from 'number' then
      perform kma_internal.program_fail('invalid_rewards', 'Each reward needs an event, a label and an amount');
    end if;
    if v_item->>'key' !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' then
      perform kma_internal.program_fail('invalid_rewards', 'A reward names an event that cannot exist');
    end if;
    v_label := btrim(v_item->>'label', E' \t\r\n');
    if length(v_label) not between 1 and 40 or v_label ~ '[\x01-\x1f\x7f]' then
      perform kma_internal.program_fail('invalid_rewards', 'A reward label must be 1 to 40 characters on one line');
    end if;
    if v_item->>'amount_minor' !~ '^[0-9]{1,15}$' or (v_item->>'amount_minor')::bigint not between 1 and 100000000 then
      perform kma_internal.program_fail('invalid_rewards', 'A reward amount must be between 1 and 100000000');
    end if;
    if exists (select 1 from jsonb_array_elements(v_rewards) r
      where r->>'key' = v_item->>'key' or lower(r->>'label') = lower(v_label)) then
      perform kma_internal.program_fail('invalid_rewards', 'Two rewards have the same event or the same label');
    end if;
    v_rewards := v_rewards || jsonb_build_object(
      'key', v_item->>'key', 'label', v_label, 'amount_minor', (v_item->>'amount_minor')::bigint);
  end loop;
  return v_rewards;
end $$;

-- The program as it would be after the form's fields are saved. Checks every field and
-- raises invalid_<field> for the first one that is wrong; writes nothing.
create or replace function kma_internal.program_apply_input(p public.affiliate_programs, p_input jsonb)
returns public.affiliate_programs language plpgsql stable set search_path = '' as $$
declare
  n public.affiliate_programs := p;
  v_published boolean := p.status in ('live', 'paused');
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
  n.landing_url := kma_internal.program_input_text(p_input, 'landing_url', p.landing_url, 2000);
  if n.landing_url is distinct from p.landing_url and n.landing_url is not null
    and not public.is_production_https_url(n.landing_url, true) then
    perform kma_internal.program_fail('invalid_landing_url', 'The landing page must be a public https address');
  end if;
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
  -- what it pays for: a commission for sales, a reward and a budget for events.
  if v_published then
    if n.name is null then perform kma_internal.program_fail('invalid_name', 'A published program needs a name'); end if;
    if n.category is null then perform kma_internal.program_fail('invalid_category', 'A published program needs a category'); end if;
    if n.tagline is null then perform kma_internal.program_fail('invalid_tagline', 'A published program needs a description'); end if;
    if n.landing_url is null then
      perform kma_internal.program_fail('invalid_landing_url', 'A published program needs a landing page');
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

-- Save the form. Creates the draft the first time.
create or replace function public.workspace_program_save(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_fields constant text[] := array['name', 'category', 'tagline', 'logo_path', 'landing_url', 'commission_type',
    'commission_rate_bps', 'commission_fixed_minor', 'currency', 'commission_duration', 'commission_months',
    'attribution_window_days', 'hold_days', 'minimum_payout_minor', 'approval_mode', 'marketplace_listed', 'extra_terms',
    'earn_from', 'rewards', 'reward_budget_minor'];
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

  update public.affiliate_programs set
    slug = n.slug, name = n.name, category = n.category, tagline = n.tagline, logo_path = n.logo_path,
    landing_url = n.landing_url, commission_type = n.commission_type, commission_rate_bps = n.commission_rate_bps,
    commission_fixed_minor = n.commission_fixed_minor, currency = n.currency,
    commission_duration = n.commission_duration, commission_months = n.commission_months,
    attribution_window_days = n.attribution_window_days, hold_days = n.hold_days,
    minimum_payout_minor = n.minimum_payout_minor, approval_mode = n.approval_mode,
    marketplace_listed = n.marketplace_listed, extra_terms = n.extra_terms,
    earn_from = n.earn_from, rewards = n.rewards, reward_budget_minor = n.reward_budget_minor,
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

-- What creators and the marketplace read ---------------------------------------------------

-- ProgramCard. The card itself is the program row, which is live as soon as it is saved;
-- the commission, the rewards and the options are the published terms, never unpublished
-- edits. A program that pays for events only has no commission: those fields are null.
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
  from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version
$$;

-- The events a reward can be for -------------------------------------------------------------

-- The event names the workspace's analytics has received, for the form's reward picker:
-- one row per name over all the workspace's projects, the most recently seen first.
create function public.workspace_program_reward_events(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace_id);
  return jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object('name', e.name, 'description', e.description,
      'first_seen', e.first_seen, 'last_seen', e.last_seen) order by e.last_seen desc, e.name)
    from (
      select d.name,
        -- The description of the project that saw the event last, among those that have one.
        (array_agg(d.description order by d.last_seen desc, d.project_id) filter (where d.description is not null))[1] as description,
        min(d.first_seen) as first_seen, max(d.last_seen) as last_seen
      from public.analytics_event_definitions d
      join public.analytics_projects j on j.id = d.project_id
      where j.workspace_id = p_workspace_id and d.status = 'live'
      group by d.name
      order by max(d.last_seen) desc, d.name
      limit 200) e), '[]'::jsonb));
end $$;

-- Judging a sale --------------------------------------------------------------------------------

-- What a sale earns, judged from the top, as an unsaved commission row. Reads only.
-- p_refunded_minor is what kma_internal.program_commission_refunded says of the sale.
-- Phase 6 adds one answer: a member whose terms pay for events only earns nothing on a sale.
create or replace function kma_internal.program_commission_decide(p_sale public.program_sales, p_refunded_minor bigint)
returns public.program_commissions language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  v_member public.affiliate_program_members;
  v_terms jsonb;
  v_first_paid_at timestamptz;
  v_account public.program_balance_accounts;
  v_status text;
begin
  c.sale_id := p_sale.id;
  c.program_id := p_sale.program_id;
  c.affiliate_id := p_sale.affiliate_id;
  c.currency := p_sale.currency;
  c.status := 'not_earned';
  c.earned_minor := 0;
  c.amount_minor := 0;
  c.fee_earned_minor := 0;
  c.fee_minor := 0;

  if p_refunded_minor >= p_sale.amount_minor then
    c.reason := 'refunded';
    return c;
  end if;
  if p_sale.affiliate_id is null then
    c.reason := 'no_creator';
    return c;
  end if;

  -- The creator was an active member of the program when the buyer paid.
  select m.* into v_member from public.affiliate_program_members m
  where m.program_id = p_sale.program_id and m.affiliate_id = p_sale.affiliate_id
    and m.activated_at <= p_sale.paid_at
    and ((m.ended_at is null and m.status = 'active') or m.ended_at > p_sale.paid_at);
  if v_member.id is null then
    c.reason := 'not_a_member';
    return c;
  end if;
  c.member_id := v_member.id;

  -- The terms they had accepted by then; before any acceptance, the first they accepted.
  c.terms_version := coalesce(
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id and a.accepted_at <= p_sale.paid_at
      order by a.accepted_at desc, a.terms_version desc limit 1),
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id
      order by a.accepted_at, a.terms_version limit 1),
    v_member.terms_version);
  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p_sale.program_id and t.version = c.terms_version;
  if v_terms is null then
    raise exception 'Terms version % of program % not found', c.terms_version, p_sale.program_id using errcode = 'P0002';
  end if;
  -- Those terms pay for events only: a sale earns nothing.
  if kma_internal.program_terms_earn_from(v_terms) = 'events' then
    c.reason := 'sales_not_rewarded';
    return c;
  end if;

  case v_terms->>'commission_duration'
    when 'first_payment' then
      if coalesce(p_sale.subscription_sequence, 1) <> 1 then
        c.reason := 'outside_duration';
      end if;
    when 'months' then
      -- Counted from the first sale of the subscription. A sale outside a subscription, and
      -- the first sale itself, always earn.
      if p_sale.first_sale_id is not null then
        select f.paid_at into v_first_paid_at from public.program_sales f where f.id = p_sale.first_sale_id;
        if p_sale.paid_at >= v_first_paid_at + make_interval(months => (v_terms->>'commission_months')::integer) then
          c.reason := 'outside_duration';
        end if;
      end if;
    when 'lifetime' then
      null;
    else
      raise exception 'Unknown commission duration in terms version %', c.terms_version using errcode = 'P0001';
  end case;
  if c.reason is not null then
    return c;
  end if;

  if p_sale.currency is distinct from v_terms->>'currency' then
    c.reason := 'currency_mismatch';
    return c;
  end if;
  select a.* into v_account from public.program_balance_accounts a where a.program_id = p_sale.program_id;
  if v_account.id is null then
    c.reason := 'balance_empty';
    return c;
  end if;
  if v_account.currency <> p_sale.currency then
    c.reason := 'currency_mismatch';
    return c;
  end if;

  select p.status into v_status from public.affiliate_programs p where p.id = p_sale.program_id;
  if v_status is distinct from 'live' then
    c.reason := 'program_paused';
    return c;
  end if;

  -- The payment without tax; the commission on it; what is left of both after any refund.
  c.basis_minor := greatest(p_sale.amount_minor - coalesce(p_sale.tax_minor, 0), 0);
  c.commission_type := v_terms->>'commission_type';
  c.commission_rate_bps := (v_terms->>'commission_rate_bps')::integer;
  c.commission_fixed_minor := (v_terms->>'commission_fixed_minor')::bigint;
  c.earned_minor := kma_internal.program_commission_of(
    c.commission_type, c.commission_rate_bps, c.commission_fixed_minor, c.basis_minor);
  if c.earned_minor is null then
    raise exception 'Unknown commission in terms version %', c.terms_version using errcode = 'P0001';
  end if;
  c.amount_minor := kma_internal.program_commission_part(c.earned_minor, p_sale.amount_minor, p_refunded_minor);
  if c.amount_minor <= 0 then
    c.reason := 'zero_amount';
    c.basis_minor := null;
    c.commission_type := null;
    c.commission_rate_bps := null;
    c.commission_fixed_minor := null;
    c.earned_minor := 0;
    c.amount_minor := 0;
    return c;
  end if;
  select s.program_fee_bps into c.fee_bps from public.platform_settings s where s.singleton;
  c.fee_earned_minor := div(c.earned_minor::numeric * c.fee_bps, 10000)::bigint;
  c.fee_minor := kma_internal.program_commission_part(c.fee_earned_minor, p_sale.amount_minor, p_refunded_minor);
  c.hold_until := p_sale.paid_at + make_interval(days => (v_terms->>'hold_days')::integer);
  c.status := 'held';
  return c;
end $$;

-- Who may call what ------------------------------------------------------------------------

revoke all on function
  kma_internal.program_terms_earn_from(jsonb),
  kma_internal.program_terms_rewards(jsonb),
  kma_internal.program_section_add(jsonb, text, text[]),
  kma_internal.program_agreement_rewards(jsonb),
  kma_internal.program_input_rewards(jsonb, jsonb),
  public.workspace_program_reward_events(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.workspace_program_reward_events(uuid) to authenticated;

commit;

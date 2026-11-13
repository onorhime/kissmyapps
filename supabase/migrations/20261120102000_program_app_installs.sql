-- Affiliate self-serve, Phase 7: programs that pay for app installs.
--
-- An app program's landing page is one of the merchant's smart links. A creator's tracking
-- redirect adds kma_click=<public click id> to it, the link service keeps that on the
-- smart-link click as params.creator_click, and when the app's first launch is matched to
-- that click (attribution_install, attribution Phase 2) the install names the creator. This
-- file is what turns that into a reward:
--
--   1. attribution_record_clicks keeps params.creator_click when it is a creator click id
--      (48 lowercase hex characters) and drops anything else.
--   2. kma_internal.attribution_install_matched, called whenever an install is written or
--      its match changes, gives the install's app session the creator click, and puts the
--      person's events that a program pays for and that were judged before the match was
--      known (app_installed, typically) back on the reward queue.
--   3. The reward judge also finds the creator through the person's install, so an event
--      that arrives after the match is credited even though its app session was opened after
--      the install call and so has no creator click of its own. For the reward
--      app_installed it adds two rules: an install KissMyApps rejected (the click came after
--      the install began) earns nothing (reason install_rejected, new here), and a reinstall
--      of the same phone earns nothing (already_rewarded). Every Phase 6 rule is kept: once
--      per person, own action, budget, daily share, balance pause, hold and reject.
--   4. The merchant's program form learns which landing pages are app links:
--      workspace_program_app_links lists them, ProgramState says whether the program's
--      landing page is one (program.app_link) and whether any exist (app_links_available),
--      and the event picker suggests what creators read for app_installed and app_opened.
--
-- Nothing a creator reads changes: an install reward is a reward like any other, and no
-- person, device, session, event or smart-link click reaches a creator. Nothing here acts
-- while program money is off.
begin;

-- Why an event earned nothing: an app install KissMyApps rejected as fraud.
alter table public.program_reward_awards drop constraint program_reward_awards_reason_check;
alter table public.program_reward_awards add constraint program_reward_awards_reason_check
  check (reason in (
    'not_a_member', 'not_in_terms', 'already_rewarded', 'own_action', 'budget_reached',
    'daily_limit', 'balance_empty', 'program_paused', 'currency_mismatch', 'install_rejected'));

-- Smart-link clicks carry the creator's click ------------------------------------------------

-- The definition from 20261103120000_merchant_attribution_links.sql, with params.creator_click:
-- the creator click (public.clicks.public_click_id) the creator's tracking redirect put on
-- the smart link as kma_click. Anything that is not 48 lowercase hex characters is dropped.
create or replace function public.attribution_record_clicks(p_clicks jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  c jsonb;
  l public.attribution_links;
  v_stored integer := 0;
  v_at timestamptz;
  v_params jsonb;
  v_ids jsonb;
  k text;
begin
  if jsonb_typeof(p_clicks) is distinct from 'array' or jsonb_array_length(p_clicks) > 500 then
    raise exception 'Send up to 500 clicks' using errcode = '22023';
  end if;
  for c in select value from jsonb_array_elements(p_clicks) loop
    continue when jsonb_typeof(c) <> 'object' or coalesce(c->>'id', '') !~ '^[A-Za-z0-9_-]{16,40}$'
      or coalesce(c->>'link_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(c->>'platform', '') not in ('ios', 'android', 'desktop')
      or coalesce(c->>'destination', '') not in ('app_store', 'play_store', 'web', 'custom', 'page')
      or coalesce(c->>'clicked_at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$';
    v_at := (c->>'clicked_at')::timestamptz;
    continue when v_at > now() + interval '5 minutes' or v_at < now() - interval '7 days';
    select * into l from public.attribution_links where id = (c->>'link_id')::uuid;
    continue when l.id is null;
    v_params := '{}';
    foreach k in array array['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'dl', 'web_id', 'from'] loop
      if kma_internal.analytics_text(c->'params'->k, 500) is not null then
        v_params := v_params || jsonb_build_object(k, kma_internal.analytics_text(c->'params'->k, 500));
      end if;
    end loop;
    if jsonb_typeof(c->'params'->'creator_click') = 'string' and c->'params'->>'creator_click' ~ '^[0-9a-f]{48}$' then
      v_params := v_params || jsonb_build_object('creator_click', c->'params'->>'creator_click');
    end if;
    v_ids := '{}';
    foreach k in array array['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] loop
      if kma_internal.analytics_text(c->'click_ids'->k, 300) is not null then
        v_ids := v_ids || jsonb_build_object(k, kma_internal.analytics_text(c->'click_ids'->k, 300));
      end if;
    end loop;
    insert into public.attribution_clicks(id, project_id, link_id, clicked_at, platform, in_app, destination,
      source, campaign, channel, adset, ad, params, click_ids, ip_hash, user_agent, referrer)
    values (c->>'id', l.project_id, l.id, v_at, c->>'platform',
      case when c->>'in_app' ~ '^[a-z0-9_]{1,30}$' then c->>'in_app' end, c->>'destination',
      -- The address may set the source and campaign for one ad (src, cmp, chn, adset, ad).
      coalesce(case when lower(c#>>'{overrides,source}') ~ '^[a-z0-9][a-z0-9_.-]{0,59}$' then lower(c#>>'{overrides,source}') end, l.source),
      coalesce(kma_internal.analytics_text(c->'overrides'->'campaign'), l.campaign),
      coalesce(kma_internal.analytics_text(c->'overrides'->'channel', 100), l.channel),
      coalesce(kma_internal.analytics_text(c->'overrides'->'adset'), l.adset),
      coalesce(kma_internal.analytics_text(c->'overrides'->'ad'), l.ad),
      v_params, v_ids,
      case when c->>'ip_sha' ~ '^[0-9a-f]{64}$'
        then encode(extensions.digest(l.project_id::text || ':' || (c->>'ip_sha'), 'sha256'), 'hex') end,
      kma_internal.analytics_text(c->'user_agent', 400),
      kma_internal.analytics_text(c->'referrer', 500))
    on conflict (id) do nothing;
    if found then
      v_stored := v_stored + 1;
    end if;
  end loop;
  return v_stored;
end $$;

-- An install names the creator -----------------------------------------------------------------

-- Called after an install is written or its match changes (attribution_install,
-- attribution_open, attribution_tick). For an install that counts (counted or flagged) and
-- carries a creator click:
--   - the app session of the install (its project, session key and person) gets the creator
--     click when it has none, so everything that reads a person's sessions to find the
--     creator (the reward judge, sale matching) finds it;
--   - every production event of the person that a published program pays for and that has
--     no award yet goes back on the reward queue, so an app_installed judged before the match
--     was known (when it found no creator) is judged again. One that is already waiting stays
--     as it is. While program money is off nothing is queued, as at the intake.
-- The install is the thing being recorded; crediting the creator comes second. Whatever goes
-- wrong in here is reported as a warning and never fails the caller.
create or replace function kma_internal.attribution_install_matched(p_install uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  i public.attribution_installs;
begin
  begin
    select * into i from public.attribution_installs x where x.id = p_install;
    if i.id is null or i.creator_click is null or i.verdict not in ('counted', 'flagged') then
      return;
    end if;
    if i.session_key is not null then
      update public.analytics_sessions s set creator_click = i.creator_click
      where s.project_id = i.project_id and s.session_key = i.session_key and s.person_id = i.person_id
        and s.creator_click is null;
    end if;
    if kma_internal.program_money_enabled() then
      insert into public.program_reward_queue(event_id, project_id, event_name, person_id, session_id, occurred_at)
      select e.id, e.project_id, e.name, e.person_id, e.session_id, e.occurred_at
      from public.analytics_events e
      join public.program_reward_events r on r.project_id = e.project_id and r.event_name = e.name
      where e.person_id = i.person_id and e.project_id = i.project_id and e.environment = 'production'
        and not exists (select 1 from public.program_reward_awards w where w.event_id = e.id)
      order by e.id
      on conflict (event_id) do nothing;
    end if;
  exception when others then
    raise warning 'The creator of install % was not credited: %', p_install, sqlerrm;
  end;
end $$;

-- Judging one event ---------------------------------------------------------------------------------

-- The definition from 20261119102000_program_reward_engine.sql, with app installs:
--   - step 2 also looks at the creator click of the person's install (counted or flagged),
--     next to the creator clicks of the person's sessions. The install call usually reaches
--     us before the first events batch, when the app session does not exist yet: the session
--     then never gets the click (attribution_install_matched finds nothing to update, and the
--     events open the session without one), but the install always has it. Both kinds of
--     touch are the creator's click itself and are timed by it (public.clicks.occurred_at),
--     so the last one at or before the event wins, the counting window runs from it, and the
--     creator must be a member when the event happens, whichever way it was found.
--   - step 6, for the reward app_installed: an install KissMyApps rejected earns nothing
--     (install_rejected), and a reinstall of a phone it saw before earns nothing
--     (already_rewarded): the install of that phone was judged the first time.
-- Everything else is word for word the Phase 6 judge.
create or replace function kma_internal.program_reward_judge(q public.program_reward_queue) returns text
language plpgsql volatile set search_path = '' as $$
declare
  a public.program_reward_awards;
  p public.affiliate_programs;
  m public.affiliate_program_members;
  v_account public.program_balance_accounts;
  v_person uuid;
  v_published jsonb;
  v_listed jsonb;
  v_terms jsonb;
  v_reward jsonb;
  v_window integer;
  v_click record;
  v_email text;
  v_budget bigint;
  v_used bigint;
  v_cap bigint;
  v_from timestamptz;
  v_fee_bps integer;
  v_fee bigint;
  v_commission uuid := gen_random_uuid();
  v_detail text;
  v_short boolean := false;
  v_install record;
begin
  -- An event is judged once.
  if exists (select 1 from public.program_reward_awards w where w.event_id = q.event_id) then
    return 'none';
  end if;

  -- 1. The program that pays for this event, and the reward as it is published now.
  select g.* into p from public.program_reward_events e
  join public.affiliate_programs g on g.id = e.program_id
  where e.project_id = q.project_id and e.event_name = q.event_name;
  if p.id is null then
    return 'none';
  end if;
  select t.terms into v_published from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version;
  v_listed := kma_internal.program_reward_of(v_published, q.event_name);
  if v_listed is null then
    return 'none';
  end if;

  -- The person as analytics knows them now: a profile that was anonymous when the event
  -- arrived may since have been folded into the profile of the user it turned out to be.
  select e.person_id into v_person from public.analytics_events e where e.id = q.event_id;
  v_person := coalesce(v_person, q.person_id);

  -- 2. The last creator link of the program's product the person opened before the event:
  -- on a visit, or through the smart link their app install was matched to.
  select c.id as click_record_id, c.affiliate_id, c.occurred_at into v_click
  from (
    select s.creator_click from public.analytics_sessions s
    where s.person_id = v_person and s.creator_click is not null
    union
    select i.creator_click from public.attribution_installs i
    where i.person_id = v_person and i.creator_click is not null and i.verdict in ('counted', 'flagged')) s
  cross join lateral kma_internal.program_sale_click(p.product_id, s.creator_click) k
  join public.clicks c on c.id = k.click_record_id
  where c.occurred_at <= q.occurred_at
  order by c.occurred_at desc, c.id desc limit 1;
  if not found then
    return 'none';
  end if;

  a.id := gen_random_uuid();
  a.program_id := p.id;
  a.reward_key := q.event_name;
  a.reward_label := v_listed->>'label';
  a.amount_minor := (v_listed->>'amount_minor')::bigint;
  a.currency := coalesce(v_published->>'currency', p.currency);
  a.event_id := q.event_id;
  a.person_id := v_person;
  a.occurred_at := q.occurred_at;
  a.affiliate_id := v_click.affiliate_id;
  a.click_record_id := v_click.click_record_id;
  a.status := 'not_earned';
  a.created_at := now();

  -- 3. The creator was an active member of the program when the event happened.
  select x.* into m from public.affiliate_program_members x
  where x.program_id = p.id and x.affiliate_id = v_click.affiliate_id
    and x.activated_at <= q.occurred_at
    and ((x.ended_at is null and x.status = 'active') or x.ended_at > q.occurred_at);
  if m.id is null then
    -- Nobody's terms apply, so the published counting window decides whether the click is
    -- still worth a line in the merchant's list.
    v_window := case when (v_published->>'attribution_window_days') ~ '^[0-9]{1,3}$'
      then (v_published->>'attribution_window_days')::integer else p.attribution_window_days end;
    if v_click.occurred_at < q.occurred_at - make_interval(days => v_window) then
      return 'none';
    end if;
    a.reason := 'not_a_member';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;
  a.member_id := m.id;

  -- 4. The terms they had accepted by then; before any acceptance, the first they accepted.
  a.terms_version := coalesce(
    (select c.terms_version from public.affiliate_program_acceptances c
      where c.member_id = m.id and c.accepted_at <= q.occurred_at
      order by c.accepted_at desc, c.terms_version desc limit 1),
    (select c.terms_version from public.affiliate_program_acceptances c
      where c.member_id = m.id
      order by c.accepted_at, c.terms_version limit 1),
    m.terms_version);
  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = a.terms_version;
  if v_terms is null then
    raise exception 'Terms version % of program % not found', a.terms_version, p.id using errcode = 'P0002';
  end if;
  v_window := case when (v_terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'
    then (v_terms->>'attribution_window_days')::integer else p.attribution_window_days end;
  if v_click.occurred_at < q.occurred_at - make_interval(days => v_window) then
    return 'none';
  end if;
  v_reward := kma_internal.program_reward_of(v_terms, q.event_name);
  if v_reward is null then
    a.reason := 'not_in_terms';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;
  -- From here on the reward is what this creator agreed to.
  a.reward_label := v_reward->>'label';
  a.amount_minor := (v_reward->>'amount_minor')::bigint;
  a.currency := coalesce(v_terms->>'currency', p.currency);

  -- 5. Money to pay it from, in the right currency, and a program that is live.
  select b.* into v_account from public.program_balance_accounts b where b.program_id = p.id;
  if v_account.id is null then
    a.reason := 'balance_empty';
  elsif v_account.currency <> a.currency then
    a.reason := 'currency_mismatch';
  elsif (select g.status from public.affiliate_programs g where g.id = p.id) is distinct from 'live' then
    a.reason := 'program_paused';
  end if;
  if a.reason is not null then
    insert into public.program_reward_awards values (a.*);
    if a.reason = 'balance_empty' then
      perform kma_internal.program_commission_pause(p.id);
    end if;
    return 'not_earned';
  end if;

  -- 6 to 10, one event of the program at a time.
  perform kma_internal.program_reward_lock(p.id);

  -- 6. An app install earns once per phone, and never when KissMyApps rejected it (the
  -- click came after the install began). A reinstall of a phone seen inside the
  -- reattribution window had its install judged the first time.
  if a.reward_key = 'app_installed' then
    select i.verdict, i.method into v_install from public.attribution_installs i
    where i.project_id = q.project_id and i.person_id = v_person;
    if v_install.verdict = 'rejected' or v_install.method = 'reinstall' then
      a.reason := case when v_install.verdict = 'rejected' then 'install_rejected' else 'already_rewarded' end;
      insert into public.program_reward_awards values (a.*);
      return 'not_earned';
    end if;
  end if;

  -- 6. Once per person. The second test finds the person through their events, so a reward
  -- earned by a profile that has since been folded into this one still counts.
  if exists (select 1 from public.program_reward_awards w
      where w.program_id = p.id and w.reward_key = a.reward_key and w.person_id = v_person
        and w.status in ('earned', 'rejected'))
    or exists (select 1 from public.analytics_events e
      join public.program_reward_awards w on w.event_id = e.id
      where e.person_id = v_person and e.name = a.reward_key and e.id <> q.event_id
        and w.program_id = p.id and w.reward_key = a.reward_key and w.status in ('earned', 'rejected')) then
    a.reason := 'already_rewarded';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 7. A creator earns nothing from their own actions: the person has the email of
  -- somebody on the creator's account. The email is compared and never written anywhere.
  select lower(btrim(pe.traits->>'email')) into v_email from public.analytics_people pe where pe.id = v_person;
  if v_email is not null and v_email <> '' and exists (
    select 1 from public.affiliate_users au join auth.users u on u.id = au.user_id
    where au.affiliate_id = a.affiliate_id and lower(btrim(u.email)) = v_email) then
    a.reason := 'own_action';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 8. The monthly budget, in the calendar month (UTC) the event happened in.
  select g.reward_budget_minor into v_budget from public.affiliate_programs g where g.id = p.id;
  v_from := date_trunc('month', q.occurred_at at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(w.amount_minor), 0) into v_used from public.program_reward_awards w
  where w.program_id = p.id and w.status = 'earned'
    and w.occurred_at >= v_from and w.occurred_at < v_from + interval '1 month';
  if v_budget is null or v_used + a.amount_minor > v_budget then
    a.reason := 'budget_reached';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 9. What one creator can earn in one day (UTC).
  v_cap := kma_internal.program_reward_daily_cap(v_budget, kma_internal.program_reward_list(v_terms));
  v_from := date_trunc('day', q.occurred_at at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(w.amount_minor), 0) into v_used from public.program_reward_awards w
  where w.program_id = p.id and w.affiliate_id = a.affiliate_id and w.status = 'earned'
    and w.occurred_at >= v_from and w.occurred_at < v_from + interval '1 day';
  if v_used + a.amount_minor > v_cap then
    a.reason := 'daily_limit';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 10. It earns: the reward and the fee are set aside together, or not at all.
  select s.program_fee_bps into v_fee_bps from public.platform_settings s where s.singleton;
  v_fee := div(a.amount_minor::numeric * v_fee_bps, 10000)::bigint;
  begin
    a.status := 'earned';
    insert into public.program_reward_awards values (a.*);
    insert into public.program_commissions(
      id, award_id, program_id, member_id, affiliate_id, terms_version, status, currency,
      basis_minor, commission_type, commission_fixed_minor, fee_bps,
      earned_minor, amount_minor, fee_earned_minor, fee_minor, hold_until)
    values (
      v_commission, a.id, p.id, m.id, a.affiliate_id, a.terms_version, 'held', a.currency,
      a.amount_minor, 'reward', a.amount_minor, v_fee_bps,
      a.amount_minor, a.amount_minor, v_fee, v_fee,
      -- An event sent late still waits out a full hold, less a day.
      greatest(q.occurred_at, clock_timestamp() - interval '1 day')
        + make_interval(days => coalesce((v_terms->>'hold_days')::integer, p.hold_days)));
    perform kma_internal.program_balance_post(v_account.id, 'commission_reserved', -a.amount_minor, null, v_commission);
    if v_fee > 0 then
      perform kma_internal.program_balance_post(v_account.id, 'fee_reserved', -v_fee, null, v_commission);
    end if;
    perform kma_internal.program_reward_commission_check(v_commission);
  exception when raise_exception then
    -- Leaving this block undoes the award, the commission and whatever was set aside.
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail is distinct from 'balance_insufficient' then
      raise;
    end if;
    v_short := true;
  end;
  if v_short then
    -- The balance cannot cover it: it earns nothing and the program pauses.
    a.status := 'not_earned';
    a.reason := 'balance_empty';
    insert into public.program_reward_awards values (a.*);
    perform kma_internal.program_commission_pause(p.id);
    return 'not_earned';
  end if;
  return 'earned';
end $$;

-- App programs -----------------------------------------------------------------------------------

-- The smart links a program's landing page can be: the active links of the workspace's
-- projects that have attribution on and an app (an App Store ID or bundle ID for iPhone, a
-- package name for Android). The address is the one the console shows for the link (its
-- project's first live domain of its own, else its subdomain of the link root).
create function kma_internal.program_app_link_rows(p_workspace uuid)
returns table (link_id uuid, url text, name text, path text, project_id uuid, project_name text,
  ios boolean, android boolean)
language sql stable set search_path = '' as $$
  select l.id, 'https://' || h.host || '/' || l.path, l.name, l.path, pr.id, pr.name,
    s.ios_app_store_id is not null or s.ios_bundle_id is not null, s.android_package is not null
  from public.analytics_projects pr
  join public.attribution_settings s on s.project_id = pr.id and s.enabled
  cross join lateral (select kma_internal.attribution_primary_host(pr.id) as host) h
  join public.attribution_links l on l.project_id = pr.id and l.status = 'active'
  where pr.workspace_id = p_workspace and h.host is not null
    and (s.ios_app_store_id is not null or s.ios_bundle_id is not null or s.android_package is not null)
$$;

-- The smart link a program's landing page is, or null for a web page: the landing page's host
-- is a domain of one of the workspace's projects and its path (without a query, a trailing
-- slash or case) is one of the links above. {"id", "url", "name"}, with the link's own
-- address, which may name another of the project's domains than the landing page does.
create function kma_internal.program_app_link(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', r.link_id, 'url', r.url, 'name', r.name)
  from kma_internal.program_app_link_rows(p.workspace_id) r
  join public.attribution_domains d on d.project_id = r.project_id
  where p.landing_url is not null
    and d.host = kma_internal.attribution_host(p.landing_url)
    and r.path = lower(btrim(coalesce(substring(p.landing_url from '^[A-Za-z]+://[^/?#]*/([^?#]*)'), ''), '/'))
  order by r.link_id
  limit 1
$$;

-- The `program` object of ProgramState: the definition from
-- 20261119101000_program_reward_terms.sql, with app_link (the smart link the landing page is,
-- or null). The admin review (kma_internal.program_review_json) is program_json and more, so
-- it shows app_link too without being written again.
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
  from kma_internal.program_check(p) c
$$;

-- What every merchant function returns: the definition from
-- 20261119101000_program_reward_terms.sql, with app_links_available (the workspace has a
-- smart link of an app that the landing page can be).
create or replace function kma_internal.program_state(p_workspace uuid, p_role text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.affiliate_programs := kma_internal.program_of(p_workspace);
  c record;
  v_connection jsonb := kma_internal.workspace_stripe_connection(p_workspace);
  v_checklist jsonb;
  v_app_links boolean := exists (select 1 from kma_internal.program_app_link_rows(p_workspace));
begin
  if p.id is null then
    return jsonb_build_object(
      'can_manage', p_role in ('owner', 'admin'),
      'stripe_connected', v_connection is not null,
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

-- The smart links the program form offers as "Your app", by project and name, at most 500:
-- {"links": [{"id", "url", "name", "project_id", "project_name", "ios", "android"}]}.
-- Choosing one makes its url the landing page. Any member of the workspace can read it.
create function public.workspace_program_app_links(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace_id);
  return jsonb_build_object('links', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.link_id, 'url', r.url, 'name', r.name,
        'project_id', r.project_id, 'project_name', r.project_name, 'ios', r.ios, 'android', r.android)
      order by r.project_name, r.name, r.link_id)
    from (
      select x.* from kma_internal.program_app_link_rows(p_workspace_id) x
      order by x.project_name, x.name, x.link_id
      limit 500) r), '[]'::jsonb));
end $$;

-- The events a reward can be for: the definition from 20261119101000_program_reward_terms.sql,
-- with suggested_label, the words the form puts in "What creators read" when the merchant
-- picks an event the app SDKs send by themselves (null for every other event).
create or replace function public.workspace_program_reward_events(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace_id);
  return jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object('name', e.name, 'description', e.description,
      'first_seen', e.first_seen, 'last_seen', e.last_seen,
      'suggested_label', case e.name when 'app_installed' then 'App installed' when 'app_opened' then 'App opened' end)
      order by e.last_seen desc, e.name)
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

-- Who may call what ------------------------------------------------------------------------------
-- The internal functions stay closed to every API role. The public ones keep the grants they
-- had (attribution_record_clicks: the attribution-links function; the reward events: people
-- of the workspace); they are named again so this file says it all.
revoke all on function
    kma_internal.attribution_install_matched(uuid),
    kma_internal.program_reward_judge(public.program_reward_queue),
    kma_internal.program_app_link_rows(uuid),
    kma_internal.program_app_link(public.affiliate_programs),
    kma_internal.program_json(public.affiliate_programs),
    kma_internal.program_state(uuid, text),
    public.attribution_record_clicks(jsonb),
    public.workspace_program_app_links(uuid),
    public.workspace_program_reward_events(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attribution_record_clicks(jsonb) to service_role;
grant execute on function public.workspace_program_app_links(uuid), public.workspace_program_reward_events(uuid)
  to authenticated;

commit;

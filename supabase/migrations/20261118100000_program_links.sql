-- Affiliate self-serve, Phase 5: links and numbers.
--
-- Links. Besides the main link, every active member of a program has one link per channel
-- (TikTok, Instagram, YouTube, Facebook, X, Newsletter) and may add up to 20 links of their
-- own. They are ordinary rows of affiliate_links for the program's product and landing
-- page: a channel link carries that channel's source, a custom link carries no source and
-- a short tag of its name in sub1 (the unique index on a link's dimensions needs one).
-- Nothing about crediting changes: a click on any of them is credited only while the
-- program is live and the membership active, by the rule the main link already follows.
--
-- A link can only be switched on while its program is live and tracking is on. One that
-- is made at another time (the backfill below for a paused program, a custom link added
-- while the program is paused) waits switched off and is switched on when the program goes
-- live, when its member becomes active again or when tracking is switched on. A link of
-- these kinds is never switched off here: a member who left keeps the rows, and the click
-- rule stops crediting them.
--
-- Numbers. A click is a visit that is not a bot on any of the creator's links for the
-- program's product. A sale is a program sale credited to the creator whose commission is
-- held or approved; its earnings are what that commission is worth now. A sale belongs to
-- the link of the click it is tied to. Days are calendar days in the creator's time zone
-- (affiliates.reporting_timezone, UTC when Postgres does not know it); a window of N days
-- ends today. Clicks are placed by clicks.occurred_at, sales by program_sales.paid_at.
--
-- The creator reads partner_program_links and partner_program_performance and changes
-- their custom links with partner_program_link_create and partner_program_link_remove. The
-- merchant's Creators page (workspace_program_creators) gains what each creator sold and
-- earned, and workspace_program_sales lists the sales creators sent. No buyer data is in
-- any answer a creator reads, and no buyer email or name in what a merchant reads.
--
-- Callers tell failures apart by the DETAIL of the error, one short code:
--   invalid_input, invalid_name, name_taken, too_many_links, link_in_use, not_removable:
--   SQLSTATE 22023; not_member: SQLSTATE 42501; link_not_found, program_not_found:
--   SQLSTATE P0002.
-- A caller with no creator account, a creator role that may not change links, or a
-- workspace role that is too low gets the repo's 42501 with no DETAIL (P0002 for a
-- workspace the caller is not in).
begin;

-- What the reads need ---------------------------------------------------------------------------

-- The sales tied to a click, and a link's clicks by day.
create index if not exists program_sales_click on public.program_sales(click_record_id)
  where click_record_id is not null;
create index if not exists clicks_link_occurred on public.clicks(affiliate_link_id, occurred_at desc);

-- The channels every member gets a link for, in the order they are shown. The key is the
-- key of the source in public.sources; the name is the link's name, so its readable
-- address ends in /tiktok, /instagram and so on.
create function kma_internal.program_link_channels() returns table (place integer, key text, name text)
language sql immutable set search_path = '' as $$
  values (1, 'tiktok', 'TikTok'), (2, 'instagram', 'Instagram'), (3, 'youtube', 'YouTube'),
    (4, 'facebook', 'Facebook'), (5, 'x', 'X'), (6, 'newsletter', 'Newsletter')
$$;

-- The source catalog already has them; a database where one is missing gets it.
insert into public.sources(key, name)
  select c.key, c.name from kma_internal.program_link_channels() c
  on conflict (key) do nothing;

-- Small helpers -----------------------------------------------------------------------------------

-- A program's currency: the one its balance is in, else the one its published terms name.
create function kma_internal.program_link_currency(p public.affiliate_programs) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select a.currency from public.program_balance_accounts a where a.program_id = p.id),
    (select t.terms->>'currency' from public.affiliate_program_terms t
      where t.program_id = p.id and t.version = p.live_terms_version),
    p.currency)
$$;

-- Whether a link of the program can be switched on now: the program is live, tracking is
-- on and the product and landing page are in place. These are the conditions the link
-- rules check when a link becomes active.
create function kma_internal.program_links_live(p public.affiliate_programs) returns boolean
language sql stable set search_path = '' as $$
  select p.status = 'live'
    and exists (select 1 from public.platform_settings s
      where s.singleton and s.tracking_enabled and s.tracking_base_url = 'https://go.kissmyapps.dev')
    and exists (select 1 from public.products x
      where x.id = p.product_id and x.status = 'active' and x.tracking_mode = 'commercial')
    and exists (select 1 from public.funnels f
      where f.id = p.funnel_id and f.product_id = p.product_id and f.status = 'live' and f.destination_url is not null)
$$;

-- What a link is within a program whose landing page is p_funnel: the main link, the link
-- of a channel (that channel's source and nothing else) or a custom link.
create function kma_internal.program_link_label(p_funnel uuid, l public.affiliate_links,
  out kind text, out channel text, out name text, out place integer)
language sql stable set search_path = '' as $$
  select case when l.is_main then 'main' when c.key is not null then 'channel' else 'custom' end,
    c.key,
    case when l.is_main then 'Main link' when c.key is not null then c.name else l.name end,
    case when l.is_main then 0 when c.key is not null then c.place else 100 end
  from (select 1) one
  left join public.sources s on s.id = l.source_id
  left join kma_internal.program_link_channels() c on c.key = s.key and not l.is_main
    and l.campaign_id is null and l.sub1 is null and l.sub2 is null and l.sub3 is null and l.funnel_id = p_funnel
$$;

-- Every link a creator has for a program's product, archived ones too, in the order the
-- Links page shows them: main, channels, custom links oldest first.
create function kma_internal.program_link_rows(p_program uuid, p_affiliate uuid)
returns table (link_id uuid, kind text, channel text, name text, url text, status public.link_status,
  created_at timestamptz, place bigint)
language sql stable set search_path = '' as $$
  select l.id, x.kind, x.channel, x.name,
    coalesce((select 'https://go.kissmyapps.dev' || a.path from kma_internal.tracking_link_aliases a where a.link_id = l.id),
      l.tracking_url),
    l.status, l.created_at,
    row_number() over (order by x.place, l.created_at, l.id)
  from public.affiliate_programs p
  join public.affiliate_links l on l.product_id = p.product_id and l.affiliate_id = p_affiliate
    and coalesce(l.tracking_environment, 'live') = 'live'
  cross join lateral kma_internal.program_link_label(p.funnel_id, l) x
  where p.id = p_program
$$;

-- The tag a custom link carries in sub1: its name in lower-case ASCII letters and digits.
create function kma_internal.program_link_tag(p_name text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40), '-'), ''), 'link')
$$;

-- The creator's time zone, or UTC when Postgres does not know it.
create function kma_internal.program_link_timezone(p_affiliate uuid) returns text
language plpgsql stable set search_path = '' as $$
declare v_zone text;
begin
  select a.reporting_timezone into v_zone from public.affiliates a where a.id = p_affiliate;
  if v_zone is null then
    return 'UTC';
  end if;
  perform now() at time zone v_zone;
  return v_zone;
exception when others then
  return 'UTC';
end $$;

-- Clicks, sales and earnings of a creator in a program between two moments, per link. A
-- link with nothing in that time has no row. Sales tied to no click come under a null link.
create function kma_internal.program_link_stats(p_program uuid, p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns table (link_id uuid, clicks bigint, sales bigint, earnings_minor bigint)
language sql stable set search_path = '' as $$
  select coalesce(c.link_id, s.link_id), coalesce(c.clicks, 0), coalesce(s.sales, 0), coalesce(s.earnings_minor, 0)::bigint
  from (
    select k.affiliate_link_id as link_id, count(*) as clicks
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = p_affiliate and k.product_id = p.product_id and not k.is_bot
      and k.occurred_at >= p_from and k.occurred_at < p_to
    join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where p.id = p_program
    group by k.affiliate_link_id) c
  full join (
    select k.affiliate_link_id as link_id, count(*) as sales, sum(x.amount_minor) as earnings_minor
    from public.program_sales s
    join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
    left join public.clicks k on k.id = s.click_record_id
    where s.program_id = p_program and s.affiliate_id = p_affiliate and s.paid_at >= p_from and s.paid_at < p_to
    group by k.affiliate_link_id) s on s.link_id = c.link_id
$$;

-- The same in one line: {"clicks", "sales", "earnings_minor"}.
create function kma_internal.program_link_totals(p_program uuid, p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('clicks', coalesce(sum(t.clicks), 0)::bigint, 'sales', coalesce(sum(t.sales), 0)::bigint,
    'earnings_minor', coalesce(sum(t.earnings_minor), 0)::bigint)
  from kma_internal.program_link_stats(p_program, p_affiliate, p_from, p_to) t
$$;

-- Making the links ------------------------------------------------------------------------------

-- Gives every active member of a program (one program, one member of it, or all) the channel
-- links they do not have, and switches on their links that were waiting. A channel link the
-- creator archived comes back, so its address works again. A link that cannot be switched
-- on now is left switched off for the next call.
create function kma_internal.program_links_sync(p_program uuid default null, p_affiliate uuid default null) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_base text;
  r record;
  v_code text;
  v_link uuid;
begin
  select s.tracking_base_url into v_base from public.platform_settings s where s.singleton;
  if v_base is null then
    return;
  end if;
  for r in
    select p.product_id, p.funnel_id, kma_internal.program_links_live(p) as live,
      m.affiliate_id, a.slug as creator_slug, c.name, s.id as source_id
    from public.affiliate_programs p
    join public.affiliate_program_members m on m.program_id = p.id and m.status = 'active'
    join public.affiliates a on a.id = m.affiliate_id
    cross join kma_internal.program_link_channels() c
    join public.sources s on s.key = c.key and s.active
    where p.status in ('live', 'paused')
      and (p_program is null or p.id = p_program) and (p_affiliate is null or m.affiliate_id = p_affiliate)
      and exists (select 1 from public.products x where x.id = p.product_id and x.tracking_mode = 'commercial')
      and exists (select 1 from public.funnels f where f.id = p.funnel_id and f.product_id = p.product_id)
      and not exists (select 1 from public.affiliate_links l
        where l.affiliate_id = m.affiliate_id and l.product_id = p.product_id and l.funnel_id = p.funnel_id
          and coalesce(l.tracking_environment, 'live') = 'live' and not l.is_main and l.status <> 'archived'
          and l.source_id = s.id and l.campaign_id is null and l.sub1 is null and l.sub2 is null and l.sub3 is null)
    order by p.id, m.activated_at, m.id, c.place
  loop
    select l.id into v_link from public.affiliate_links l
    where l.affiliate_id = r.affiliate_id and l.product_id = r.product_id and l.funnel_id = r.funnel_id
      and coalesce(l.tracking_environment, 'live') = 'live' and not l.is_main and l.status = 'archived'
      and l.commercial_eligible
      and l.source_id = r.source_id and l.campaign_id is null and l.sub1 is null and l.sub2 is null and l.sub3 is null
    order by l.created_at desc, l.id limit 1
    for update;
    if v_link is not null then
      update public.affiliate_links set status = 'paused' where id = v_link;
      if r.live then
        update public.affiliate_links set status = 'active' where id = v_link;
      end if;
    else
      v_code := encode(extensions.gen_random_bytes(18), 'hex');
      insert into public.affiliate_links(
        affiliate_id, product_id, funnel_id, source_id, name, public_code, tracking_url,
        is_main, commercial_eligible, tracking_environment, status, created_by, created_at)
      values (
        r.affiliate_id, r.product_id, r.funnel_id, r.source_id, r.name, v_code,
        v_base || '/r/' || r.creator_slug || '/' || v_code,
        false, true, 'live', case when r.live then 'active' else 'paused' end::public.link_status, auth.uid(),
        clock_timestamp());
    end if;
  end loop;

  update public.affiliate_links l set status = 'active'
  from public.affiliate_programs p
  join public.affiliate_program_members m on m.program_id = p.id and m.status = 'active'
  where l.product_id = p.product_id and l.affiliate_id = m.affiliate_id
    and l.status = 'paused' and not l.is_main and l.commercial_eligible
    and coalesce(l.tracking_environment, 'live') = 'live' and l.campaign_id is null
    and (l.source_id is null or exists (select 1 from public.sources s where s.id = l.source_id and s.active))
    and exists (select 1 from public.funnels f where f.id = l.funnel_id and f.status = 'live')
    and (p_program is null or p.id = p_program) and (p_affiliate is null or m.affiliate_id = p_affiliate)
    and kma_internal.program_links_live(p);
end $$;

-- The three moments links are made or switched on. Links come second to what set the
-- trigger off (a creator joining, a program going live when money arrives, the tracking
-- switch): a failure here is reported as a warning and the next call makes up for it.
create function kma_internal.program_links_on_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'active' then
    return null;
  end if;
  begin
    perform kma_internal.program_links_sync(new.program_id, new.affiliate_id);
  exception when others then
    raise warning 'The links of program member % were not made: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger affiliate_program_members_links
  after insert or update of status on public.affiliate_program_members
  for each row when (new.status = 'active') execute function kma_internal.program_links_on_member();

create function kma_internal.program_links_on_program() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform kma_internal.program_links_sync(new.id);
  exception when others then
    raise warning 'The links of program % were not switched on: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger affiliate_programs_links
  after update of status on public.affiliate_programs
  for each row when (new.status = 'live' and old.status is distinct from 'live')
  execute function kma_internal.program_links_on_program();

create function kma_internal.program_links_on_tracking() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform kma_internal.program_links_sync();
  exception when others then
    raise warning 'Program links were not switched on: %', sqlerrm;
  end;
  return null;
end $$;
create trigger platform_settings_program_links
  after update of tracking_enabled on public.platform_settings
  for each row when (new.tracking_enabled and not old.tracking_enabled)
  execute function kma_internal.program_links_on_tracking();

-- Members who are active already get their channel links now, a program at a time. A
-- program whose links cannot be made does not stop the migration: it is named in a warning,
-- and running kma_internal.program_links_sync() again makes them.
do $$
declare r record;
begin
  for r in select p.id from public.affiliate_programs p where p.status in ('live', 'paused') order by p.created_at, p.id loop
    begin
      perform kma_internal.program_links_sync(r.id);
    exception when others then
      raise warning 'The channel links of program % were not made: %', r.id, sqlerrm;
    end;
  end loop;
end $$;

-- What a creator reads ----------------------------------------------------------------------------

-- One program on the Links page: the member's links that are not archived, with what each
-- brought in the last 30 days of the creator's calendar.
create function kma_internal.program_links_json(p public.affiliate_programs, p_affiliate uuid) returns jsonb
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
      'working', v_working,
      'paused_reason', case when v_working then null
        when p.status = 'paused' and p.pause_reason = 'balance_empty' then 'balance_empty'
        else 'program_paused' end,
      'custom_links', count(*) filter (where r.kind = 'custom'),
      'links', coalesce(jsonb_agg(jsonb_build_object(
          'link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name, 'url', r.url,
          'created_at', r.created_at,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'earnings_minor', coalesce(t.earnings_minor, 0),
          'removable', r.kind = 'custom'
            and not exists (select 1 from public.clicks k where k.affiliate_link_id = r.link_id))
        order by r.place), '[]'::jsonb))
    from kma_internal.program_link_rows(p.id, p_affiliate) r
    left join kma_internal.program_link_stats(p.id, p_affiliate, v_from, v_to) t on t.link_id = r.link_id
    where r.status <> 'archived');
end $$;

-- The Links page: the signed-in creator's active memberships, by program name.
create function public.partner_program_links() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_affiliate uuid := kma_internal.program_creator(false);
begin
  return jsonb_build_object(
    'stats_days', 30,
    'max_custom_links', 20,
    'channels', (select jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name) order by c.place)
      from kma_internal.program_link_channels() c),
    'programs', coalesce((
      select jsonb_agg(kma_internal.program_links_json(p, v_affiliate) order by p.name, p.id)
      from public.affiliate_program_members m
      join public.affiliate_programs p on p.id = m.program_id
      where m.affiliate_id = v_affiliate and m.status = 'active'), '[]'::jsonb));
end $$;

-- The signed-in creator, for a change to their links: the owner or a member of the
-- creator account, as for the links of the older products.
create function kma_internal.program_link_creator() returns uuid
language plpgsql stable set search_path = '' as $$
declare v_affiliate uuid := public.current_partner_affiliate_id(true);
begin
  if not public.current_user_has_affiliate_role(v_affiliate, array['owner', 'member']::text[], true) then
    raise exception 'Your role on this creator account cannot change links' using errcode = '42501';
  end if;
  return v_affiliate;
end $$;

-- Adds a custom link to one of the creator's programs.
create function public.partner_program_link_create(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_link_creator();
  p public.affiliate_programs;
  m public.affiliate_program_members;
  v_name text;
  v_base text;
  v_slug text;
  v_tag text;
  v_sub1 text;
  v_try integer := 1;
  v_code text;
  v_link uuid;
  v_live boolean;
begin
  perform kma_internal.program_member_input(p_input, array['slug', 'name']);
  if jsonb_typeof(p_input->'slug') is distinct from 'string' then
    perform kma_internal.program_fail('invalid_input', 'slug must be text');
  end if;
  if jsonb_typeof(p_input->'name') is distinct from 'string' then
    perform kma_internal.program_fail('invalid_name', 'Give the link a name');
  end if;
  -- One line of text: spaces of any kind become one space.
  v_name := btrim(regexp_replace(p_input->>'name', '\s+', ' ', 'g'));
  if length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]' then
    perform kma_internal.program_fail('invalid_name', 'Give the link a name of up to 40 characters');
  end if;

  select * into p from public.affiliate_programs where slug = p_input->>'slug' for share;
  if p.id is not null then
    perform kma_internal.program_member_lock(p.id, v_affiliate);
    select * into m from public.affiliate_program_members
    where program_id = p.id and affiliate_id = v_affiliate and status = 'active';
  end if;
  if m.id is null or p.product_id is null or p.funnel_id is null then
    perform kma_internal.program_fail('not_member', 'You are not a member of this program', '42501');
  end if;

  if lower(v_name) = 'main link'
    or exists (select 1 from kma_internal.program_link_channels() c where lower(c.name) = lower(v_name))
    or exists (select 1 from kma_internal.program_link_rows(p.id, v_affiliate) r
      join public.affiliate_links l on l.id = r.link_id
      where r.status <> 'archived' and (lower(r.name) = lower(v_name) or lower(l.name) = lower(v_name))) then
    perform kma_internal.program_fail('name_taken', 'You already have a link with this name');
  end if;
  if (select count(*) from kma_internal.program_link_rows(p.id, v_affiliate) r
      where r.status <> 'archived' and r.kind = 'custom') >= 20 then
    perform kma_internal.program_fail('too_many_links', 'You can have up to 20 custom links for a program');
  end if;

  v_live := kma_internal.program_links_live(p);
  -- A link of this name that was removed comes back with the address it had.
  select l.id into v_link from public.affiliate_links l
  where l.affiliate_id = v_affiliate and l.product_id = p.product_id and l.funnel_id = p.funnel_id
    and coalesce(l.tracking_environment, 'live') = 'live' and not l.is_main and l.status = 'archived'
    and l.commercial_eligible
    and l.source_id is null and l.campaign_id is null and l.sub1 is not null and l.sub2 is null and l.sub3 is null
    and lower(l.name) = lower(v_name)
    and not exists (select 1 from public.clicks k where k.affiliate_link_id = l.id)
    and not exists (select 1 from public.affiliate_links o
      where o.affiliate_id = l.affiliate_id and o.product_id = l.product_id and o.funnel_id = l.funnel_id
        and coalesce(o.tracking_environment, 'live') = 'live' and o.status <> 'archived'
        and o.source_id is null and o.campaign_id is null and o.sub1 = l.sub1 and o.sub2 is null and o.sub3 is null)
  order by l.created_at desc, l.id limit 1
  for update;
  if v_link is not null then
    update public.affiliate_links set status = 'paused', name = v_name where id = v_link;
    if v_live then
      update public.affiliate_links set status = 'active' where id = v_link;
    end if;
    return kma_internal.program_links_json(p, v_affiliate);
  end if;

  select s.tracking_base_url into v_base from public.platform_settings s where s.singleton;
  select a.slug into v_slug from public.affiliates a where a.id = v_affiliate;
  if v_base is null then
    perform kma_internal.program_fail('tracking_not_enabled', 'Links are not available yet');
  end if;
  -- The tag only has to differ from the member's other links without a source.
  v_tag := kma_internal.program_link_tag(v_name);
  v_sub1 := v_tag;
  while exists (select 1 from public.affiliate_links o
    where o.affiliate_id = v_affiliate and o.product_id = p.product_id and o.funnel_id = p.funnel_id
      and coalesce(o.tracking_environment, 'live') = 'live' and o.status <> 'archived'
      and o.source_id is null and o.campaign_id is null and o.sub1 = v_sub1 and o.sub2 is null and o.sub3 is null)
  loop
    v_try := v_try + 1;
    v_sub1 := v_tag || '-' || v_try;
  end loop;
  v_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links(
    affiliate_id, product_id, funnel_id, name, public_code, tracking_url, sub1,
    is_main, commercial_eligible, tracking_environment, status, created_by, created_at)
  values (
    v_affiliate, p.product_id, p.funnel_id, v_name, v_code, v_base || '/r/' || v_slug || '/' || v_code, v_sub1,
    false, true, 'live', case when v_live then 'active' else 'paused' end::public.link_status, auth.uid(),
    clock_timestamp());
  return kma_internal.program_links_json(p, v_affiliate);
end $$;

-- Removes a custom link that nobody has opened yet. The row is archived, never deleted.
create function public.partner_program_link_remove(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_link_creator();
  v_id uuid;
  l public.affiliate_links;
  p public.affiliate_programs;
  v_kind text;
begin
  perform kma_internal.program_member_input(p_input, array['link_id']);
  if jsonb_typeof(p_input->'link_id') = 'string' then
    v_id := kma_internal.workspace_stripe_uuid(p_input->>'link_id');
  end if;
  if v_id is null then
    perform kma_internal.program_fail('invalid_input', 'link_id must be a UUID');
  end if;
  -- The lock keeps a first click from arriving while the link is being removed.
  select * into l from public.affiliate_links x
  where x.id = v_id and x.affiliate_id = v_affiliate and x.status <> 'archived'
    and coalesce(x.tracking_environment, 'live') = 'live'
  for update;
  select q.* into p from public.affiliate_programs q
  join public.affiliate_program_members m on m.program_id = q.id and m.affiliate_id = v_affiliate and m.status = 'active'
  where q.product_id = l.product_id;
  if l.id is null or p.id is null then
    perform kma_internal.program_fail('link_not_found', 'Link not found', 'P0002');
  end if;
  select x.kind into v_kind from kma_internal.program_link_label(p.funnel_id, l) x;
  if v_kind <> 'custom' then
    perform kma_internal.program_fail('not_removable', 'This link cannot be removed');
  end if;
  if exists (select 1 from public.clicks k where k.affiliate_link_id = l.id) then
    perform kma_internal.program_fail('link_in_use', 'This link has been opened, so it stays');
  end if;
  update public.affiliate_links set status = 'archived' where id = l.id;
  return kma_internal.program_links_json(p, v_affiliate);
end $$;

-- A program in the picker of the Performance page.
create function kma_internal.program_link_brief(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('program_id', p.id, 'slug', p.slug, 'name', p.name,
    'currency', kma_internal.program_link_currency(p))
$$;

-- The creator's money in one program, to date: the same sums as that program's line of
-- partner_program_earnings.
create function kma_internal.program_link_money(p_program uuid, p_affiliate uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor,
    'paying_minor', en.paying_minor, 'paid_minor', en.paid_minor, 'next_release_at', cm.next_release_at)
  from (
    select coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
      min(x.hold_until) filter (where x.status = 'held') as next_release_at
    from public.program_commissions x
    where x.program_id = p_program and x.affiliate_id = p_affiliate) cm
  cross join (
    select coalesce(sum(e.amount_minor), 0)::bigint as approved_minor,
      coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status in ('approved', 'processing')), 0)::bigint
        as paying_minor,
      coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status = 'paid'), 0)::bigint as paid_minor
    from public.program_creator_entries e
    left join public.program_payouts o on o.id = e.payout_id
    where e.program_id = p_program and e.affiliate_id = p_affiliate) en
$$;

-- The Performance page: one program of the signed-in creator over the last 7, 30 or 90
-- days of their calendar, the same number of days before it, each day, each link, their
-- money in the program and their latest commissions. No buyer data.
create function public.partner_program_performance(p_input jsonb) returns jsonb
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
      'totals', '{"clicks":0,"sales":0,"earnings_minor":0}'::jsonb,
      'previous', '{"clicks":0,"sales":0,"earnings_minor":0}'::jsonb,
      'daily', '[]'::jsonb, 'channels', '[]'::jsonb, 'money', null, 'latest', '[]'::jsonb);
  end if;

  return v_answer || jsonb_build_object(
    'program', kma_internal.program_link_brief(p),
    'totals', kma_internal.program_link_totals(p.id, v_affiliate, v_from, v_to),
    'previous', kma_internal.program_link_totals(p.id, v_affiliate,
      (v_start - v_days)::timestamp at time zone v_zone, v_from),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d.day, 'clicks', coalesce(c.clicks, 0),
          'sales', coalesce(s.sales, 0), 'earnings_minor', coalesce(s.earnings_minor, 0)) order by d.day)
      from (select g::date as day from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') g) d
      left join (
        select (k.occurred_at at time zone v_zone)::date as day, count(*) as clicks
        from public.clicks k
        join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
        where k.affiliate_id = v_affiliate and k.product_id = p.product_id and not k.is_bot
          and k.occurred_at >= v_from and k.occurred_at < v_to
        group by 1) c on c.day = d.day
      left join (
        select (s.paid_at at time zone v_zone)::date as day, count(*) as sales, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_sales s
        join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
        where s.program_id = p.id and s.affiliate_id = v_affiliate and s.paid_at >= v_from and s.paid_at < v_to
        group by 1) s on s.day = d.day),
    'channels', (
      -- The links that are not archived, then one line for whatever belongs to no such link.
      select coalesce(jsonb_agg(q.line order by q.place), '[]'::jsonb)
      from (
        select r.place, jsonb_build_object('link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'earnings_minor', coalesce(t.earnings_minor, 0)) as line
        from kma_internal.program_link_rows(p.id, v_affiliate) r
        left join kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t on t.link_id = r.link_id
        where r.status <> 'archived'
        union all
        select 1000000, jsonb_build_object('link_id', null, 'kind', 'none', 'channel', null, 'name', 'No link',
          'clicks', coalesce(sum(t.clicks), 0)::bigint, 'sales', coalesce(sum(t.sales), 0)::bigint,
          'earnings_minor', coalesce(sum(t.earnings_minor), 0)::bigint)
        from kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t
        where not exists (select 1 from kma_internal.program_link_rows(p.id, v_affiliate) r
          where r.link_id = t.link_id and r.status <> 'archived')
        having coalesce(sum(t.sales), 0) > 0) q),
    'money', kma_internal.program_link_money(p.id, v_affiliate),
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object('paid_at', q.paid_at, 'link_name', q.link_name,
          'amount_minor', q.amount_minor, 'status', q.status) order by q.place)
      from (
        select s.paid_at, coalesce(b.name, 'No link') as link_name, x.amount_minor, x.status,
          row_number() over (order by s.paid_at desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        join public.program_sales s on s.id = x.sale_id
        left join public.clicks k on k.id = s.click_record_id
        left join public.affiliate_links l on l.id = k.affiliate_link_id
        left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
        where x.program_id = p.id and x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 5) q), '[]'::jsonb));
end $$;

-- What a merchant reads ---------------------------------------------------------------------------

-- A member's numbers to date: clicks on every link they have for the program's product,
-- their sales by the same rule the creator's own pages and the Sales summary use (a sale
-- credited to them whose commission is held or approved: a refunded sale and one that
-- earned nothing are listed on the Sales page and not counted here), what those sales came
-- to (the payments as they were made), and what their commissions are worth now with the
-- part still held. A sale recorded while program money was off has no commission to judge
-- it by and counts as it always did.
create function kma_internal.program_link_member_stats(m public.affiliate_program_members,
  out clicks bigint, out last_click_at timestamptz, out sales bigint, out sales_amount_minor bigint,
  out commission_minor bigint, out pending_minor bigint)
language sql stable set search_path = '' as $$
  select c.clicks, c.last_click_at, s.sales, s.sales_amount_minor, s.commission_minor, s.pending_minor
  from (
    -- Naming the creator lets the clicks index find them.
    select count(*) as clicks, max(k.occurred_at) as last_click_at
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = m.affiliate_id and k.product_id = p.product_id and not k.is_bot
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
$$;

-- Creator: what a merchant sees about one member. No email, no legal name.
create or replace function kma_internal.program_creator_json(m public.affiliate_program_members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'member_id', m.id, 'status', m.status, 'name', a.public_name, 'handle', a.slug,
    'country_code', a.country_code, 'channels', to_jsonb(a.channels), 'website_url', a.website_url,
    'requested_at', m.requested_at, 'activated_at', m.activated_at, 'ended_at', m.ended_at,
    'decision_note', m.decision_note,
    'terms_version', m.terms_version, 'needs_new_terms', m.terms_version < p.live_terms_version,
    'clicks', c.clicks, 'sales', c.sales, 'last_click_at', c.last_click_at,
    'sales_amount_minor', c.sales_amount_minor, 'commission_minor', c.commission_minor, 'pending_minor', c.pending_minor)
  from public.affiliate_programs p
  join public.affiliates a on a.id = m.affiliate_id
  cross join lateral kma_internal.program_link_member_stats(m) c
  where p.id = m.program_id
$$;

-- The Creators page: the workspace's program, everyone who joined or asked to, and what
-- they sold and earned.
create or replace function public.workspace_program_creators(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
begin
  return jsonb_build_object(
    'can_manage', v_role in ('owner', 'admin'),
    'program', case when p.id is not null then jsonb_build_object(
      'id', p.id, 'slug', p.slug, 'name', p.name, 'status', p.status,
      -- How creators are approved today: the published terms, or the form before the first approval.
      'approval_mode', coalesce((select t.terms->>'approval_mode' from public.affiliate_program_terms t
        where t.program_id = p.id and t.version = p.live_terms_version), p.approval_mode),
      'marketplace_listed', p.marketplace_listed) end,
    'currency', case when p.id is not null then kma_internal.program_link_currency(p) end,
    'counts', (
      select jsonb_build_object(
        'pending', count(*) filter (where m.status = 'pending'),
        'active', count(*) filter (where m.status = 'active'),
        'ended', count(*) filter (where m.status in ('declined', 'removed', 'left')))
      from public.affiliate_program_members m where m.program_id = p.id),
    -- Every creator who is or was active, not only the 500 listed below.
    'totals', (
      select jsonb_build_object(
        'clicks', coalesce(sum(c.clicks), 0)::bigint, 'sales', coalesce(sum(c.sales), 0)::bigint,
        'sales_amount_minor', coalesce(sum(c.sales_amount_minor), 0)::bigint,
        'commission_minor', coalesce(sum(c.commission_minor), 0)::bigint,
        'pending_minor', coalesce(sum(c.pending_minor), 0)::bigint)
      from public.affiliate_program_members m
      cross join lateral kma_internal.program_link_member_stats(m) c
      where m.program_id = p.id and m.status in ('active', 'removed', 'left')),
    'creators', coalesce((
      select jsonb_agg(kma_internal.program_creator_json(q.m) order by q.place)
      from (
        select m, row_number() over (order by
          case m.status when 'pending' then 1 when 'active' then 2 else 3 end,
          case when m.status = 'pending' then m.requested_at end,
          coalesce(m.ended_at, m.activated_at) desc, m.id) as place
        from public.affiliate_program_members m where m.program_id = p.id
        order by place limit 500) q), '[]'::jsonb));
end $$;

-- The Sales page: the sales creators sent, newest first, a page at a time, and the last
-- 30 days in one line. A payment with no creator is not listed. No buyer email or name.
-- Each sale names its own currency: a payment made in another currency than the program's
-- is listed too (it earns nothing), and its amount is not in the program's currency.
create function public.workspace_program_sales(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
  v_limit integer := 50;
  v_before timestamptz;
  v_member uuid;
  v_affiliate uuid;
  v_cut timestamptz;
  v_more boolean := false;
  v_sales jsonb := '[]'::jsonb;
  v_since timestamptz := ((now() at time zone 'UTC')::date - 29)::timestamp at time zone 'UTC';
begin
  perform kma_internal.program_member_input(p_input, array['limit', 'before', 'member_id']);
  if jsonb_typeof(p_input->'limit') = 'number' and p_input->>'limit' ~ '^[0-9]{1,3}$' then
    v_limit := (p_input->>'limit')::integer;
  elsif jsonb_typeof(p_input->'limit') <> 'null' then
    v_limit := 0;
  end if;
  if v_limit not between 1 and 100 then
    perform kma_internal.program_fail('invalid_input', 'limit must be a whole number from 1 to 100');
  end if;
  if jsonb_typeof(p_input->'before') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end if;
  begin
    v_before := (p_input->>'before')::timestamptz;
  exception when others then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end;
  if jsonb_typeof(p_input->'member_id') not in ('string', 'null')
    or (p_input->>'member_id' is not null and kma_internal.workspace_stripe_uuid(p_input->>'member_id') is null) then
    perform kma_internal.program_fail('invalid_input', 'member_id must be a UUID');
  end if;
  v_member := kma_internal.workspace_stripe_uuid(p_input->>'member_id');
  -- A member of another program matches nothing.
  select m.affiliate_id into v_affiliate from public.affiliate_program_members m
  where m.id = v_member and m.program_id = p.id;

  if p.id is not null then
    -- A page ends on a whole moment: sales paid in the same instant as its last one come with
    -- it, so the next page can start strictly before that instant and miss nothing.
    select min(q.paid_at) into v_cut from (
      select s.paid_at from public.program_sales s
      where s.program_id = p.id and s.affiliate_id is not null
        and (v_before is null or s.paid_at < v_before) and (v_member is null or s.affiliate_id = v_affiliate)
      order by s.paid_at desc, s.id desc limit v_limit) q;
    v_more := exists (select 1 from public.program_sales s
      where s.program_id = p.id and s.affiliate_id is not null and s.paid_at < v_cut
        and (v_member is null or s.affiliate_id = v_affiliate));
    select coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', s.id, 'paid_at', s.paid_at, 'amount_minor', s.amount_minor, 'currency', s.currency,
        'refunded_minor', s.refunded_minor,
        'member_id', (select m.id from public.affiliate_program_members m
          where m.program_id = s.program_id and m.affiliate_id = s.affiliate_id),
        'creator_name', a.public_name, 'link_name', coalesce(b.name, 'No link'), 'match_source', s.match_source,
        'status', case x.status when 'held' then 'pending' when 'approved' then 'approved'
          when 'reversed' then 'returned' when 'not_earned' then 'not_earned' else 'not_judged' end,
        'reason', x.reason, 'commission_minor', coalesce(x.amount_minor, 0), 'fee_minor', coalesce(x.fee_minor, 0),
        'hold_until', x.hold_until)
      order by s.paid_at desc, s.id desc), '[]'::jsonb) into v_sales
    from public.program_sales s
    join public.affiliates a on a.id = s.affiliate_id
    left join public.program_commissions x on x.sale_id = s.id
    left join public.clicks k on k.id = s.click_record_id
    left join public.affiliate_links l on l.id = k.affiliate_link_id
    left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
    where s.program_id = p.id and s.affiliate_id is not null and s.paid_at >= v_cut
      and (v_before is null or s.paid_at < v_before) and (v_member is null or s.affiliate_id = v_affiliate);
  end if;

  return jsonb_build_object(
    'program', case when p.id is not null then
      jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'status', p.status) end,
    'currency', case when p.id is not null then kma_internal.program_link_currency(p) end,
    'summary', (
      select jsonb_build_object('days', 30, 'sales', count(*),
        'sales_amount_minor', coalesce(sum(s.amount_minor), 0)::bigint,
        'commission_minor', coalesce(sum(x.amount_minor), 0)::bigint,
        'fee_minor', coalesce(sum(x.fee_minor), 0)::bigint)
      from public.program_sales s
      join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
      where s.program_id = p.id and s.affiliate_id is not null and s.paid_at >= v_since),
    'sales', v_sales,
    'next_before', case when v_more then v_cut end);
end $$;

-- Access --------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal' and (p.proname like 'program\_link%' or p.proname = 'program_creator_json')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
    public.partner_program_links(), public.partner_program_link_create(jsonb),
    public.partner_program_link_remove(jsonb), public.partner_program_performance(jsonb),
    public.workspace_program_creators(uuid), public.workspace_program_sales(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
    public.partner_program_links(), public.partner_program_link_create(jsonb),
    public.partner_program_link_remove(jsonb), public.partner_program_performance(jsonb),
    public.workspace_program_creators(uuid), public.workspace_program_sales(uuid, jsonb)
  to authenticated;

commit;

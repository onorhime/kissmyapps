-- Affiliate self-serve, Phase 3: creators join a merchant's program.
--
-- The marketplace is read by the public edge function (marketplace_programs,
-- marketplace_program). A signed-in creator browses it (partner_marketplace), opens a
-- program (partner_program_detail) and accepts its agreement with one press
-- (partner_program_join). A program that approves creators automatically gives the creator
-- a working main link at once; otherwise the request waits for the merchant
-- (workspace_program_creators, workspace_program_creator_decide). A creator can accept a
-- newer version of the terms (partner_program_accept_terms) and leave (partner_program_leave).
--
-- Nothing here signs a document, makes a KissMyApps offer or works out commission.
--
-- Callers tell failures apart by the DETAIL of the error, which is one short code:
--   invalid_input, invalid_<field>, program_not_open, already_member, membership_closed,
--   tracking_not_enabled, not_a_member, status_not_allowed: all with SQLSTATE 22023;
--   terms_changed (the version or hash sent is not the live one): SQLSTATE 40001;
--   program_not_found: SQLSTATE P0002.
-- A caller with no creator account, or a workspace role that is too low, gets the repo's
-- 42501 (and P0002 for a workspace the caller is not in) with no DETAIL.
begin;

-- What the functions return ------------------------------------------------------------------

-- ProgramCard. The card itself is the program row, which is live as soon as it is saved;
-- the commission and the options are the published terms, never unpublished edits.
create function kma_internal.program_card(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'slug', p.slug, 'name', p.name, 'category', p.category, 'tagline', p.tagline, 'logo_path', p.logo_path,
    'brand_name', coalesce(t.terms->>'brand_name', p.name),
    'commission_type', t.terms->'commission_type', 'commission_rate_bps', t.terms->'commission_rate_bps',
    'commission_fixed_minor', t.terms->'commission_fixed_minor', 'currency', t.terms->'currency',
    'commission_duration', t.terms->'commission_duration', 'commission_months', t.terms->'commission_months',
    'attribution_window_days', t.terms->'attribution_window_days', 'hold_days', t.terms->'hold_days',
    'minimum_payout_minor', t.terms->'minimum_payout_minor',
    'approval_mode', t.terms->'approval_mode', 'terms_version', t.version)
  from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version
$$;

-- ProgramDetail: the card, the program's id (the creator functions that change a membership
-- take it), where its links lead and the agreement a creator accepts.
create function kma_internal.program_detail(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select kma_internal.program_card(p) || jsonb_build_object(
    'id', p.id, 'status', p.status, 'landing_url', p.landing_url,
    'agreement', t.agreement, 'agreement_sha256', t.agreement_sha256)
  from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version
$$;

-- The programs the marketplace lists: live and listed, newest first, at most 200.
create function kma_internal.program_marketplace() returns table (program public.affiliate_programs, place bigint)
language sql stable set search_path = '' as $$
  select p, row_number() over (order by p.first_published_at desc, p.id)
  from public.affiliate_programs p
  where p.status = 'live' and p.marketplace_listed
  order by p.first_published_at desc, p.id
  limit 200
$$;

-- Membership: what a creator sees about their own membership.
create function kma_internal.program_membership_json(m public.affiliate_program_members) returns jsonb
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
    'decision_note', m.decision_note)
  from public.affiliate_programs p where p.id = m.program_id
$$;

-- Creator: what a merchant sees about one member. No email, no legal name.
create function kma_internal.program_creator_json(m public.affiliate_program_members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'member_id', m.id, 'status', m.status, 'name', a.public_name, 'handle', a.slug,
    'country_code', a.country_code, 'channels', to_jsonb(a.channels), 'website_url', a.website_url,
    'requested_at', m.requested_at, 'activated_at', m.activated_at, 'ended_at', m.ended_at,
    'decision_note', m.decision_note,
    'terms_version', m.terms_version, 'needs_new_terms', m.terms_version < p.live_terms_version,
    'clicks', c.clicks, 'sales', (select count(*) from public.program_sales s
      where s.program_id = m.program_id and s.affiliate_id = m.affiliate_id),
    'last_click_at', c.last_click_at)
  from public.affiliate_programs p
  join public.affiliates a on a.id = m.affiliate_id
  cross join lateral (
    -- A link's clicks are all its creator's; naming the creator lets the clicks index find them.
    select count(*) as clicks, max(k.occurred_at) as last_click_at
    from public.clicks k
    where k.affiliate_id = m.affiliate_id and k.affiliate_link_id = m.main_link_id and not k.is_bot) c
  where p.id = m.program_id
$$;

-- Who is asking, and what they sent -----------------------------------------------------------

-- The signed-in creator's account. Reading needs any role on it; accepting an agreement
-- or leaving a program is for its owner, like signing was.
create function kma_internal.program_creator(p_change boolean) returns uuid
language plpgsql stable set search_path = '' as $$
declare v_affiliate uuid := public.current_partner_affiliate_id(true);
begin
  if p_change and not public.current_user_has_affiliate_role(v_affiliate, array['owner']::text[], true) then
    raise exception 'Only the owner of a creator account can join or leave a program' using errcode = '42501';
  end if;
  return v_affiliate;
end $$;

-- The name a creator accepts under, as the acceptance screen shows it.
create function kma_internal.program_accept_name(p_affiliate uuid) returns text
language sql stable set search_path = '' as $$
  select left(coalesce(nullif(btrim(a.legal_name), ''), nullif(btrim(a.public_name), '')), 200)
  from public.affiliates a where a.id = p_affiliate
$$;

-- A request is a JSON object with only the keys it may have.
create function kma_internal.program_member_input(p_input jsonb, p_keys text[]) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    perform kma_internal.program_fail('invalid_input', 'The request must be a JSON object');
  end if;
  if exists (select 1 from jsonb_object_keys(p_input) k where k <> all(p_keys)) then
    perform kma_internal.program_fail('invalid_input', 'The request has fields that are not allowed');
  end if;
end $$;

-- The published terms the creator says they read. They must be the ones in force now.
create function kma_internal.program_member_terms(p public.affiliate_programs, p_input jsonb)
returns public.affiliate_program_terms language plpgsql stable set search_path = '' as $$
declare t public.affiliate_program_terms;
begin
  if jsonb_typeof(p_input->'terms_version') is distinct from 'number' or p_input->>'terms_version' !~ '^[0-9]{1,9}$' then
    perform kma_internal.program_fail('invalid_terms_version', 'terms_version must be a whole number');
  end if;
  if jsonb_typeof(p_input->'agreement_sha256') is distinct from 'string' or p_input->>'agreement_sha256' !~ '^[a-f0-9]{64}$' then
    perform kma_internal.program_fail('invalid_agreement_sha256', 'agreement_sha256 must be the hash of the agreement');
  end if;
  if p.status <> 'live' then
    perform kma_internal.program_fail('program_not_open', 'This program is not taking creators right now');
  end if;
  select * into t from public.affiliate_program_terms where program_id = p.id and version = p.live_terms_version;
  if t.version is distinct from (p_input->>'terms_version')::integer
    or t.agreement_sha256 is distinct from p_input->>'agreement_sha256' then
    perform kma_internal.program_fail('terms_changed', 'The agreement changed. Read it again', '40001');
  end if;
  return t;
end $$;

-- One change to a creator's membership of a program at a time.
create function kma_internal.program_member_lock(p_program uuid, p_affiliate uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('affiliate-program-member:' || p_program::text || ':' || p_affiliate::text, 0))
$$;

-- One audit row per change: only the columns that changed, before and after.
create function kma_internal.program_member_audit(
  p_action text, p_actor_type text, p_before public.affiliate_program_members, p_after public.affiliate_program_members,
  p_reason text default null
) returns void language sql volatile set search_path = '' as $$
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, reason, before_data, after_data)
  select auth.uid(), p_actor_type, p_action, 'affiliate_program_members', p_after.id, p_reason,
    (select jsonb_object_agg(b.key, b.value) from jsonb_each(to_jsonb(p_before)) b
      where p_before.id is not null and b.value is distinct from to_jsonb(p_after)->b.key),
    (select jsonb_object_agg(a.key, a.value) from jsonb_each(to_jsonb(p_after)) a
      where p_before.id is null or a.value is distinct from to_jsonb(p_before)->a.key)
$$;

-- The record that the creator agreed to exactly this text. One row per member per version:
-- accepting the same version again keeps the first row.
create function kma_internal.program_member_accept(
  p_member public.affiliate_program_members, p_terms public.affiliate_program_terms, p_name text, p_now timestamptz
) returns void language sql volatile set search_path = '' as $$
  insert into public.affiliate_program_acceptances(
    member_id, program_id, terms_version, agreement_sha256, accepted_by, accepted_name, accepted_at)
  values (p_member.id, p_member.program_id, p_terms.version, p_terms.agreement_sha256, auth.uid(), p_name, p_now)
  on conflict (member_id, terms_version) do nothing
$$;

-- Becoming active, ending ---------------------------------------------------------------------

-- Makes a member active and gives them a working main link. The link rules only let a
-- program link be active while its member is active, and a member can only be active with
-- a link, so the order is: the link exists switched off, the member becomes active with
-- it, the link is switched on. p_decider is the merchant who approved, or null when the
-- creator's own acceptance was enough.
create function kma_internal.program_member_activate(
  p public.affiliate_programs, m public.affiliate_program_members, p_decider uuid, p_note text, p_now timestamptz
) returns public.affiliate_program_members language plpgsql volatile set search_path = '' as $$
declare
  v_base text;
  v_creator public.affiliates;
  v_product public.products;
  v_funnel public.funnels;
  v_link public.affiliate_links;
  v_code text;
  v_saved public.affiliate_program_members;
begin
  select s.tracking_base_url into v_base
  from public.platform_settings s
  where s.singleton and s.tracking_enabled and s.tracking_base_url = 'https://go.kissmyapps.dev'
  for share;
  if v_base is null then
    perform kma_internal.program_fail('tracking_not_enabled', 'Links are not available yet');
  end if;
  select * into v_creator from public.affiliates a where a.id = m.affiliate_id and a.status = 'active' for share;
  if v_creator.id is null then
    perform kma_internal.program_fail('status_not_allowed', 'This creator''s account is not active');
  end if;
  select * into v_product from public.products x
  where x.id = p.product_id and x.status = 'active' and x.tracking_mode = 'commercial' for share;
  select * into v_funnel from public.funnels f
  where f.id = p.funnel_id and f.product_id = p.product_id and f.is_default and f.status = 'live'
    and f.destination_url is not null for share;
  if p.status <> 'live' or v_product.id is null or v_funnel.id is null then
    perform kma_internal.program_fail('program_not_open', 'This program is not taking creators right now');
  end if;

  -- The same lock the admin flow takes before it issues a main link.
  perform pg_advisory_xact_lock(hashtextextended('main-link:' || m.affiliate_id::text || ':' || p.product_id::text, 0));
  -- The creator's current main link for this product, if they have one: their own from an
  -- earlier membership, or one from the admin flow. There can only be one.
  select * into v_link from public.affiliate_links l
  where l.affiliate_id = m.affiliate_id and l.product_id = p.product_id and l.is_main
    and coalesce(l.tracking_environment, 'live') = 'live' and l.status <> 'archived'
  order by l.created_at desc limit 1
  for update;
  if v_link.id is null and m.main_link_id is not null then
    -- Their link was archived meanwhile: it comes back, so the address they shared works again.
    update public.affiliate_links set status = 'paused'
    where id = m.main_link_id and status = 'archived' returning * into v_link;
  end if;
  if v_link.id is null then
    v_code := encode(extensions.gen_random_bytes(18), 'hex');
    insert into public.affiliate_links(
      affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
      is_main, commercial_eligible, tracking_environment, status, created_by)
    values (
      m.affiliate_id, p.product_id, v_funnel.id, left(v_product.name, 113) || ' · Main', v_code,
      v_base || '/r/' || v_creator.slug || '/' || v_code,
      true, true, 'live', 'paused', auth.uid())
    returning * into v_link;
  end if;
  if not v_link.commercial_eligible then
    perform kma_internal.program_fail('program_not_open', 'This program is not taking creators right now');
  end if;

  update public.affiliate_program_members set
    status = 'active', main_link_id = v_link.id, activated_at = coalesce(activated_at, p_now), ended_at = null,
    decided_by = case when p_decider is null then decided_by else p_decider end,
    decided_at = case when p_decider is null then decided_at else p_now end,
    decision_note = case when p_decider is null then decision_note else p_note end,
    updated_at = p_now
  where id = m.id returning * into v_saved;
  if v_link.status <> 'active' then
    update public.affiliate_links set status = 'active' where id = v_link.id;
  end if;
  return v_saved;
end $$;

-- Ends a membership (declined, removed or left) and switches its link off. The link keeps
-- sending visitors to the landing page; it records and credits nothing.
create function kma_internal.program_member_end(
  m public.affiliate_program_members, p_status text, p_decider uuid, p_note text, p_now timestamptz
) returns public.affiliate_program_members language plpgsql volatile set search_path = '' as $$
declare v_saved public.affiliate_program_members;
begin
  update public.affiliate_program_members set
    status = p_status, ended_at = p_now,
    decided_by = case when p_decider is null then decided_by else p_decider end,
    decided_at = case when p_decider is null then decided_at else p_now end,
    decision_note = case when p_decider is null then decision_note else p_note end,
    updated_at = p_now
  where id = m.id returning * into v_saved;
  update public.affiliate_links set status = 'paused' where id = m.main_link_id and status = 'active';
  return v_saved;
end $$;

-- The marketplace, for the public edge function -------------------------------------------------

create function public.marketplace_programs() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('programs', coalesce(
    (select jsonb_agg(kma_internal.program_card(q.program) order by q.place) from kma_internal.program_marketplace() q),
    '[]'::jsonb))
$$;

-- One program by its address. A program that is not listed is still reachable this way:
-- its address is the merchant's invite link.
create function public.marketplace_program(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('program', (
    select kma_internal.program_detail(p) from public.affiliate_programs p
    where p.slug = p_slug and p.status in ('live', 'paused')))
$$;

-- Creator functions -----------------------------------------------------------------------------

-- The marketplace as a signed-in creator sees it, and every membership they have.
create function public.partner_marketplace() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_affiliate uuid := kma_internal.program_creator(false);
begin
  return jsonb_build_object(
    'tracking_ready', exists (select 1 from public.platform_settings s
      where s.singleton and s.tracking_enabled and s.tracking_base_url = 'https://go.kissmyapps.dev'),
    'programs', coalesce((
      select jsonb_agg(kma_internal.program_card(q.program) || jsonb_build_object('membership_status', (
          select m.status from public.affiliate_program_members m
          where m.program_id = (q.program).id and m.affiliate_id = v_affiliate)) order by q.place)
      from kma_internal.program_marketplace() q), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(kma_internal.program_membership_json(m) order by
        case m.status when 'active' then 1 when 'pending' then 2 else 3 end,
        coalesce(m.ended_at, m.activated_at, m.requested_at) desc, m.id)
      from public.affiliate_program_members m where m.affiliate_id = v_affiliate), '[]'::jsonb));
end $$;

-- One program, the creator's membership of it and the name they would accept under.
create function public.partner_program_detail(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(false);
  p public.affiliate_programs;
  m public.affiliate_program_members;
begin
  select * into p from public.affiliate_programs where slug = p_slug;
  select * into m from public.affiliate_program_members where program_id = p.id and affiliate_id = v_affiliate;
  if p.id is null or (p.status not in ('live', 'paused') and m.id is null) then
    perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
  end if;
  return jsonb_build_object(
    'program', kma_internal.program_detail(p),
    'membership', case when m.id is not null then kma_internal.program_membership_json(m) end,
    'accept_name', kma_internal.program_accept_name(v_affiliate));
end $$;

-- Accept and get my link. With automatic approval the creator is active at once;
-- otherwise the request waits for the merchant.
create function public.partner_program_join(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(true);
  p public.affiliate_programs;
  t public.affiliate_program_terms;
  v_before public.affiliate_program_members;
  v_saved public.affiliate_program_members;
  v_name text;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_member_input(p_input, array['slug', 'terms_version', 'agreement_sha256']);
  if jsonb_typeof(p_input->'slug') is distinct from 'string' then
    perform kma_internal.program_fail('invalid_slug', 'slug must be text');
  end if;
  -- The share lock keeps the program as it is (live, these terms) until this is done.
  select * into p from public.affiliate_programs
  where slug = p_input->>'slug' and status in ('live', 'paused', 'archived') for share;
  if p.id is null then
    perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
  end if;
  t := kma_internal.program_member_terms(p, p_input);

  perform kma_internal.program_member_lock(p.id, v_affiliate);
  select * into v_before from public.affiliate_program_members
  where program_id = p.id and affiliate_id = v_affiliate for update;
  if v_before.status in ('pending', 'active') then
    perform kma_internal.program_fail('already_member', 'You have already joined this program');
  elsif v_before.status in ('declined', 'removed') then
    perform kma_internal.program_fail('membership_closed', 'This program is not open to you');
  end if;
  v_name := kma_internal.program_accept_name(v_affiliate);
  if v_name is null then
    perform kma_internal.program_fail('invalid_accept_name', 'Add your name to your profile first');
  end if;

  if v_before.id is null then
    insert into public.affiliate_program_members(
      program_id, affiliate_id, status, terms_version, joined_by, requested_at, updated_at)
    values (p.id, v_affiliate, 'pending', t.version, auth.uid(), v_now, v_now)
    returning * into v_saved;
  else
    -- Joining again after leaving is a new request: the old decision no longer applies.
    update public.affiliate_program_members set
      status = 'pending', terms_version = t.version, joined_by = auth.uid(), requested_at = v_now,
      decided_by = null, decided_at = null, decision_note = null, ended_at = null, updated_at = v_now
    where id = v_before.id returning * into v_saved;
  end if;
  perform kma_internal.program_member_accept(v_saved, t, v_name, v_now);
  if t.terms->>'approval_mode' is distinct from 'manual' then
    v_saved := kma_internal.program_member_activate(p, v_saved, null, null, v_now);
  end if;
  perform kma_internal.program_member_audit(
    case when v_saved.status = 'active' then 'affiliate_program_member_joined' else 'affiliate_program_member_requested' end,
    'affiliate', v_before, v_saved);
  return jsonb_build_object('membership', kma_internal.program_membership_json(v_saved));
end $$;

-- The creator's membership of the program named in a request, locked for a change.
-- Raises program_not_found, and not_a_member unless the membership is pending or active.
create function kma_internal.program_member_of_creator(p_input jsonb, p_affiliate uuid)
returns public.affiliate_program_members language plpgsql volatile set search_path = '' as $$
declare
  v_id uuid;
  p public.affiliate_programs;
  m public.affiliate_program_members;
begin
  if jsonb_typeof(p_input->'program_id') = 'string' then
    v_id := kma_internal.workspace_stripe_uuid(p_input->>'program_id');
  end if;
  if v_id is null then
    perform kma_internal.program_fail('invalid_program_id', 'program_id must be a UUID');
  end if;
  select * into p from public.affiliate_programs where id = v_id and status in ('live', 'paused', 'archived') for share;
  if p.id is null then
    perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
  end if;
  perform kma_internal.program_member_lock(p.id, p_affiliate);
  select * into m from public.affiliate_program_members
  where program_id = p.id and affiliate_id = p_affiliate for update;
  if m.id is null or m.status not in ('pending', 'active') then
    perform kma_internal.program_fail('not_a_member', 'You are not a member of this program');
  end if;
  return m;
end $$;

-- A member accepts the newer version of the terms the merchant published.
create function public.partner_program_accept_terms(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(true);
  p public.affiliate_programs;
  t public.affiliate_program_terms;
  v_before public.affiliate_program_members;
  v_saved public.affiliate_program_members;
  v_name text;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_member_input(p_input, array['program_id', 'terms_version', 'agreement_sha256']);
  v_before := kma_internal.program_member_of_creator(p_input, v_affiliate);
  select * into p from public.affiliate_programs where id = v_before.program_id;
  t := kma_internal.program_member_terms(p, p_input);
  if v_before.terms_version = t.version then
    return jsonb_build_object('membership', kma_internal.program_membership_json(v_before));
  end if;
  v_name := kma_internal.program_accept_name(v_affiliate);
  if v_name is null then
    perform kma_internal.program_fail('invalid_accept_name', 'Add your name to your profile first');
  end if;
  perform kma_internal.program_member_accept(v_before, t, v_name, v_now);
  update public.affiliate_program_members set terms_version = t.version, updated_at = v_now
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_member_audit('affiliate_program_member_terms_accepted', 'affiliate', v_before, v_saved);
  return jsonb_build_object('membership', kma_internal.program_membership_json(v_saved));
end $$;

-- A creator leaves, or withdraws a request that is still waiting.
create function public.partner_program_leave(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(true);
  v_before public.affiliate_program_members;
  v_saved public.affiliate_program_members;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_member_input(p_input, array['program_id']);
  v_before := kma_internal.program_member_of_creator(p_input, v_affiliate);
  v_saved := kma_internal.program_member_end(v_before, 'left', null, null, v_now);
  perform kma_internal.program_member_audit('affiliate_program_member_left', 'affiliate', v_before, v_saved);
  return jsonb_build_object('membership', kma_internal.program_membership_json(v_saved));
end $$;

-- Merchant functions ----------------------------------------------------------------------------

-- The Creators page: the workspace's program and everyone who joined or asked to.
create function public.workspace_program_creators(p_workspace_id uuid) returns jsonb
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
    'counts', (
      select jsonb_build_object(
        'pending', count(*) filter (where m.status = 'pending'),
        'active', count(*) filter (where m.status = 'active'),
        'ended', count(*) filter (where m.status in ('declined', 'removed', 'left')))
      from public.affiliate_program_members m where m.program_id = p.id),
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

-- The merchant approves, declines or removes a creator.
create function public.workspace_program_creator_decide(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  p public.affiliate_programs;
  v_id uuid;
  v_affiliate uuid;
  v_action text;
  v_note text;
  v_before public.affiliate_program_members;
  v_saved public.affiliate_program_members;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_member_input(p_input, array['member_id', 'action', 'note']);
  if jsonb_typeof(p_input->'member_id') = 'string' then
    v_id := kma_internal.workspace_stripe_uuid(p_input->>'member_id');
  end if;
  if v_id is null then
    perform kma_internal.program_fail('invalid_member_id', 'member_id must be a UUID');
  end if;
  v_action := p_input->>'action';
  if jsonb_typeof(p_input->'action') is distinct from 'string' or v_action not in ('approve', 'decline', 'remove') then
    perform kma_internal.program_fail('invalid_action', 'Choose approve, decline or remove');
  end if;
  if p_input ? 'note' and jsonb_typeof(p_input->'note') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_note', 'The note must be text');
  end if;
  v_note := nullif(btrim(coalesce(p_input->>'note', ''), E' \t\r\n'), '');
  if length(v_note) > 500 then
    perform kma_internal.program_fail('invalid_note', 'Write a note of up to 500 characters');
  end if;

  select * into p from public.affiliate_programs
  where workspace_id = p_workspace_id and status <> 'archived' for share;
  select m.affiliate_id into v_affiliate from public.affiliate_program_members m
  where m.id = v_id and m.program_id = p.id;
  if v_affiliate is null then
    perform kma_internal.program_fail('not_a_member', 'This creator is not in your program');
  end if;
  perform kma_internal.program_member_lock(p.id, v_affiliate);
  select * into v_before from public.affiliate_program_members where id = v_id for update;

  if v_action = 'approve' and v_before.status in ('pending', 'declined', 'removed') then
    if p.status <> 'live' then
      perform kma_internal.program_fail('program_not_open', 'Creators can be approved once the program is live');
    end if;
    v_saved := kma_internal.program_member_activate(p, v_before, auth.uid(), v_note, v_now);
  elsif v_action = 'decline' and v_before.status = 'pending' then
    v_saved := kma_internal.program_member_end(v_before, 'declined', auth.uid(), v_note, v_now);
  elsif v_action = 'remove' and v_before.status = 'active' then
    v_saved := kma_internal.program_member_end(v_before, 'removed', auth.uid(), v_note, v_now);
  else
    perform kma_internal.program_fail('status_not_allowed', 'That cannot be done to this creator now');
  end if;
  perform kma_internal.program_member_audit(
    case v_action when 'approve' then 'affiliate_program_member_approved'
      when 'decline' then 'affiliate_program_member_declined' else 'affiliate_program_member_removed' end,
    'system', v_before, v_saved, v_note);
  return jsonb_build_object('creator', kma_internal.program_creator_json(v_saved));
end $$;

-- Who may call what ------------------------------------------------------------------------

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
  public.marketplace_programs(),
  public.marketplace_program(text),
  public.partner_marketplace(),
  public.partner_program_detail(text),
  public.partner_program_join(jsonb),
  public.partner_program_accept_terms(jsonb),
  public.partner_program_leave(jsonb),
  public.workspace_program_creators(uuid),
  public.workspace_program_creator_decide(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.marketplace_programs(),
  public.marketplace_program(text)
to service_role;
grant execute on function
  public.partner_marketplace(),
  public.partner_program_detail(text),
  public.partner_program_join(jsonb),
  public.partner_program_accept_terms(jsonb),
  public.partner_program_leave(jsonb),
  public.workspace_program_creators(uuid),
  public.workspace_program_creator_decide(uuid, jsonb)
to authenticated;

commit;

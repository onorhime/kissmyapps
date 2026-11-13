-- Affiliate self-serve, Phase 2: everything that reads and changes a workspace's program.
--
-- A merchant fills in one form (workspace_program_save), reads the agreement KissMyApps
-- generates from it (workspace_program_agreement, workspace_program_mark_agreement_read)
-- and publishes (workspace_program_submit). KissMyApps reviews the first listing once
-- (list_admin_program_reviews, review_admin_program). Approval creates the product, its
-- default funnel and terms version 1. Later term changes publish a new version with no
-- second review. Creators cannot join yet: nothing here creates a link or a commission.
--
-- The merchant functions are called by the signed-in member, never by the service role.
-- Callers tell failures apart by the DETAIL of the error, which is one short code:
-- invalid_input, invalid_<field>, program_changed (SQLSTATE 40001), program_incomplete,
-- stripe_not_connected, agreement_not_read, program_in_review, program_paused_by_admin,
-- nothing_to_publish, status_not_allowed, program_not_found. Every code except
-- program_changed and program_not_found (P0002) comes with SQLSTATE 22023.
--
-- Production needs nothing set up beforehand for an approval to work: the products and
-- funnels tables only have audit and updated_at triggers. The tracking origin check lives
-- in activate_admin_product, which this path does not use.
begin;

-- Logos ---------------------------------------------------------------------------------
-- A public bucket: the logo is shown on the marketplace card and at the top of the
-- agreement. Objects live at <workspace_id>/<file>.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('program-logos', 'program-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- True when the first folder of the object name is a workspace the caller owns or administers.
create function public.can_manage_program_logo(p_object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.analytics_workspace_members m
    where m.user_id = auth.uid() and m.role in ('owner', 'admin')
      and m.workspace_id = kma_internal.workspace_stripe_uuid(split_part(p_object_name, '/', 1)))
$$;

-- Anyone can open a logo by its public address; these policies cover the storage API,
-- which also needs to read a row before it replaces or deletes it.
drop policy if exists program_logos_manager_select on storage.objects;
create policy program_logos_manager_select on storage.objects for select to authenticated
  using (bucket_id = 'program-logos' and public.can_manage_program_logo(name));
drop policy if exists program_logos_manager_insert on storage.objects;
create policy program_logos_manager_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'program-logos' and public.can_manage_program_logo(name));
drop policy if exists program_logos_manager_update on storage.objects;
create policy program_logos_manager_update on storage.objects for update to authenticated
  using (bucket_id = 'program-logos' and public.can_manage_program_logo(name))
  with check (bucket_id = 'program-logos' and public.can_manage_program_logo(name));
drop policy if exists program_logos_manager_delete on storage.objects;
create policy program_logos_manager_delete on storage.objects for delete to authenticated
  using (bucket_id = 'program-logos' and public.can_manage_program_logo(name));

-- Small helpers -------------------------------------------------------------------------

create function kma_internal.program_fail(p_code text, p_message text, p_errcode text default '22023') returns void
language plpgsql immutable set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = p_errcode, detail = p_code;
end $$;

-- Money in normal units: $1,250.00 for US dollars, 1,250.00 EUR for the rest. Programs
-- only use currencies with two decimal places (see program_apply_input).
create function kma_internal.program_money(p_minor bigint, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select case when p_currency = 'USD' then '$' || a.amount else a.amount || ' ' || p_currency end
  from (
    select regexp_replace((p_minor / 100)::text, '(\d)(?=(\d{3})+$)', '\1,', 'g')
      || '.' || lpad((p_minor % 100)::text, 2, '0') as amount
  ) a
$$;

-- 3000 -> 30%, 1250 -> 12.5%, 105 -> 1.05%.
create function kma_internal.program_percent(p_bps integer) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_bps % 100 = 0 then (p_bps / 100)::text
    else rtrim((p_bps / 100)::text || '.' || lpad((p_bps % 100)::text, 2, '0'), '0')
  end || '%'
$$;

-- 1 day, 30 days, 12 months.
create function kma_internal.program_count(p_count integer, p_unit text) returns text
language sql immutable set search_path = '' as $$
  select p_count || ' ' || p_unit || case when p_count = 1 then '' else 's' end
$$;

create function kma_internal.program_section(p_heading text, variadic p_paragraphs text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('heading', p_heading, 'paragraphs', to_jsonb(p_paragraphs))
$$;

-- The agreement --------------------------------------------------------------------------

-- The one-line commission, as it appears in the agreement summary.
create function kma_internal.program_commission_headline(p_terms jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_terms->>'commission_type'
      when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of '
      else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, p_terms->>'currency') || ' on '
    end
    || case p_terms->>'commission_duration'
      when 'first_payment' then 'the first payment'
      when 'months' then 'every payment for ' || kma_internal.program_count((p_terms->>'commission_months')::integer, 'month')
      else 'every payment'
    end
$$;

-- The agreement a creator accepts, generated from a terms snapshot and nothing else: no
-- dates, no logo, no lookups. The same terms always give the same document, so its hash
-- tells whether the merchant has read exactly this text and whether it has been published.
create function kma_internal.program_agreement(p_terms jsonb) returns jsonb
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

create function kma_internal.program_agreement_sha256(p_agreement jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_agreement::text, 'utf8')), 'hex')
$$;

-- Reading a program ------------------------------------------------------------------------

-- The commercial snapshot the agreement is generated from, or null while the form is too
-- empty to generate one. The brand is the business name on the connected Stripe account.
-- While Stripe is disconnected a published program keeps the brand it was published with;
-- a program that never had one goes by its own name.
create function kma_internal.program_terms(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'program_name', p.name,
    'brand_name', coalesce(
      kma_internal.workspace_stripe_connection(p.workspace_id)->>'business_name',
      (select t.terms->>'brand_name' from public.affiliate_program_terms t
        where t.program_id = p.id and t.version = p.live_terms_version),
      p.name),
    'landing_url', p.landing_url,
    'commission_type', p.commission_type,
    'commission_rate_bps', p.commission_rate_bps,
    'commission_fixed_minor', p.commission_fixed_minor,
    'currency', p.currency,
    'commission_duration', p.commission_duration,
    'commission_months', p.commission_months,
    'attribution_window_days', p.attribution_window_days,
    'hold_days', p.hold_days,
    'minimum_payout_minor', p.minimum_payout_minor,
    'approval_mode', p.approval_mode,
    'extra_terms', p.extra_terms)
  where p.name is not null and p.landing_url is not null
    and p.commission_type is not null and p.commission_duration is not null
$$;

-- Everything that is worked out from a program rather than stored on it.
create function kma_internal.program_check(
  p public.affiliate_programs,
  out stripe_connected boolean, out details boolean, out landing_page boolean, out commission boolean,
  out complete boolean, out terms jsonb, out agreement jsonb, out sha256 text,
  out agreement_read boolean, out has_unpublished_changes boolean
) language plpgsql stable set search_path = '' as $$
begin
  stripe_connected := kma_internal.workspace_stripe_connection(p.workspace_id) is not null;
  details := p.name is not null and p.category is not null and p.tagline is not null;
  landing_page := p.landing_url is not null;
  commission := p.commission_type is not null and p.commission_duration is not null;
  complete := details and landing_page and commission;
  terms := kma_internal.program_terms(p);
  agreement := kma_internal.program_agreement(terms);
  sha256 := kma_internal.program_agreement_sha256(agreement);
  agreement_read := sha256 is not null and p.agreement_read_sha256 is not distinct from sha256;
  has_unpublished_changes := p.status in ('live', 'paused') and sha256 is distinct from (
    select t.agreement_sha256 from public.affiliate_program_terms t
    where t.program_id = p.id and t.version = p.live_terms_version);
end $$;

-- The `program` object of ProgramState.
create function kma_internal.program_json(p public.affiliate_programs) returns jsonb
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
    'agreement_read', c.agreement_read,
    'has_unpublished_changes', c.has_unpublished_changes,
    'live_terms_version', p.live_terms_version,
    'submitted_at', p.submitted_at, 'first_published_at', p.first_published_at, 'updated_at', p.updated_at)
  from kma_internal.program_check(p) c
$$;

-- The workspace's program: the one row that is not archived.
create function kma_internal.program_of(p_workspace uuid) returns public.affiliate_programs
language sql stable set search_path = '' as $$
  select p from public.affiliate_programs p where p.workspace_id = p_workspace and p.status <> 'archived'
$$;

-- What every merchant function returns.
create function kma_internal.program_state(p_workspace uuid, p_role text) returns jsonb
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
    'program', kma_internal.program_json(p),
    'checklist', v_checklist,
    -- A first listing can be sent for review; a published program only has something to
    -- publish when its terms changed.
    'can_submit', c.stripe_connected and c.complete and c.agreement_read
      and (p.status in ('draft', 'changes_requested') or c.has_unpublished_changes));
end $$;

-- Changing a program ---------------------------------------------------------------------

-- One change to a workspace's program at a time.
create function kma_internal.program_lock(p_workspace uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('affiliate-program:' || p_workspace::text, 0))
$$;

-- Holds the workspace's Stripe connection still until this transaction ends, so a program
-- cannot go live while that connection is being disconnected. The disconnect locks the
-- connection first and the program second; so does every caller of this, before it takes
-- the program lock.
create function kma_internal.program_lock_stripe(p_workspace uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform 1 from public.merchant_connections c
  join public.merchant_businesses b on b.id = c.merchant_id
  where b.workspace_id = p_workspace and c.livemode
  for share of c;
end $$;

-- The workspace's program, locked for a change.
create function kma_internal.program_for_update(p_workspace uuid) returns public.affiliate_programs
language plpgsql volatile set search_path = '' as $$
declare p public.affiliate_programs;
begin
  perform kma_internal.program_lock(p_workspace);
  select * into p from public.affiliate_programs
  where workspace_id = p_workspace and status <> 'archived' for update;
  return p;
end $$;

-- The caller must have seen the latest saved copy.
create function kma_internal.program_require_revision(p public.affiliate_programs, p_revision integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_revision is distinct from p.revision then
    perform kma_internal.program_fail('program_changed', 'The program changed since you opened it', '40001');
  end if;
end $$;

-- One audit row per change: only the columns that changed, before and after.
create function kma_internal.program_audit(
  p_action text, p_actor_type text, p_before public.affiliate_programs, p_after public.affiliate_programs,
  p_reason text default null
) returns void language sql volatile set search_path = '' as $$
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, reason, before_data, after_data)
  select auth.uid(), p_actor_type, p_action, 'affiliate_programs', p_after.id, p_reason,
    (select jsonb_object_agg(b.key, b.value) from jsonb_each(to_jsonb(p_before)) b
      where p_before.id is not null and b.value is distinct from to_jsonb(p_after)->b.key),
    (select jsonb_object_agg(a.key, a.value) from jsonb_each(to_jsonb(p_after)) a
      where p_before.id is null or a.value is distinct from to_jsonb(p_before)->a.key)
$$;

-- A text field from the form. Absent: unchanged. Null or blank: cleared.
create function kma_internal.program_input_text(
  p_input jsonb, p_key text, p_current text, p_max integer, p_single_line boolean default true
) returns text language plpgsql immutable set search_path = '' as $$
declare v_value text;
begin
  if not p_input ? p_key then
    return p_current;
  end if;
  if jsonb_typeof(p_input->p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_input->p_key) <> 'string' then
    perform kma_internal.program_fail('invalid_' || p_key, format('%s must be text', p_key));
  end if;
  v_value := p_input->>p_key;
  if btrim(v_value, E' \t\r\n') = '' then
    return null;
  end if;
  if p_single_line then
    v_value := btrim(v_value);
  end if;
  if length(v_value) > p_max or (p_single_line and v_value ~ '[\x01-\x1f\x7f]') then
    perform kma_internal.program_fail('invalid_' || p_key, format('%s is too long or has line breaks', p_key));
  end if;
  return v_value;
end $$;

-- A whole number from the form. Absent: unchanged. Null: back to the default.
create function kma_internal.program_input_int(
  p_input jsonb, p_key text, p_current bigint, p_min bigint, p_max bigint, p_default bigint default null
) returns bigint language plpgsql immutable set search_path = '' as $$
declare v_value bigint;
begin
  if not p_input ? p_key then
    return p_current;
  end if;
  if jsonb_typeof(p_input->p_key) = 'null' then
    return p_default;
  end if;
  if jsonb_typeof(p_input->p_key) <> 'number' or p_input->>p_key !~ '^-?[0-9]{1,15}$' then
    perform kma_internal.program_fail('invalid_' || p_key, format('%s must be a whole number', p_key));
  end if;
  v_value := (p_input->>p_key)::bigint;
  if v_value not between p_min and p_max then
    perform kma_internal.program_fail('invalid_' || p_key, format('%s must be between %s and %s', p_key, p_min, p_max));
  end if;
  return v_value;
end $$;

-- A choice from a fixed list. Absent: unchanged. Null: back to the default.
create function kma_internal.program_input_choice(
  p_input jsonb, p_key text, p_current text, p_choices text[], p_default text default null
) returns text language plpgsql immutable set search_path = '' as $$
begin
  if not p_input ? p_key then
    return p_current;
  end if;
  if jsonb_typeof(p_input->p_key) = 'null' then
    return p_default;
  end if;
  if jsonb_typeof(p_input->p_key) <> 'string' or not (p_input->>p_key = any(p_choices)) then
    perform kma_internal.program_fail('invalid_' || p_key, format('%s is not one of the choices', p_key));
  end if;
  return p_input->>p_key;
end $$;

-- The program as it would be after the form's fields are saved. Checks every field and
-- raises invalid_<field> for the first one that is wrong; writes nothing.
create function kma_internal.program_apply_input(p public.affiliate_programs, p_input jsonb)
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
  -- Amounts are stored in hundredths, so only currencies with two decimal places are taken.
  if n.currency !~ '^[A-Z]{3}$' or n.currency = any(array[
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
    'BHD', 'JOD', 'KWD', 'OMR', 'TND', 'ISK', 'HUF', 'TWD']) then
    perform kma_internal.program_fail('invalid_currency', 'Choose a currency with two decimal places');
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
  -- a published program must keep a full commission.
  if n.commission_type is not null and coalesce(n.commission_rate_bps, n.commission_fixed_minor) is null then
    if v_published then
      perform kma_internal.program_fail(
        case n.commission_type when 'percent' then 'invalid_commission_rate_bps' else 'invalid_commission_fixed_minor' end,
        'Enter the commission amount');
    end if;
    n.commission_type := null;
  end if;

  -- A published program cannot lose what it was approved with.
  if v_published then
    if n.name is null then perform kma_internal.program_fail('invalid_name', 'A published program needs a name'); end if;
    if n.category is null then perform kma_internal.program_fail('invalid_category', 'A published program needs a category'); end if;
    if n.tagline is null then perform kma_internal.program_fail('invalid_tagline', 'A published program needs a description'); end if;
    if n.landing_url is null then
      perform kma_internal.program_fail('invalid_landing_url', 'A published program needs a landing page');
    end if;
    if n.commission_type is null then
      perform kma_internal.program_fail('invalid_commission_type', 'A published program needs a commission');
    end if;
    if n.commission_duration is null then
      perform kma_internal.program_fail('invalid_commission_duration', 'A published program needs a commission duration');
    end if;
  end if;
  return n;
end $$;

-- The marketplace address for a name: lower-case words joined by hyphens, with -2, -3 ...
-- when another program already has it.
create function kma_internal.program_slug(p_name text, p_program uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_base text := btrim(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 60), '-');
  v_slug text;
  v_count integer := 1;
begin
  if length(v_base) < 2 then
    v_base := btrim('program-' || v_base, '-');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('affiliate-program-slug', 0));
  v_slug := v_base;
  while exists (select 1 from public.affiliate_programs where slug = v_slug and id is distinct from p_program) loop
    v_count := v_count + 1;
    v_slug := v_base || '-' || v_count;
  end loop;
  return v_slug;
end $$;

-- Writes the next version of a program's terms and returns its number.
create function kma_internal.program_publish_terms(p public.affiliate_programs, p_author uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  c record;
  v_version integer;
begin
  select * into c from kma_internal.program_check(p);
  insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
  select p.id, coalesce(max(t.version), 0) + 1, c.terms, c.agreement, c.sha256, p_author
  from public.affiliate_program_terms t where t.program_id = p.id
  returning version into v_version;
  return v_version;
end $$;

-- Merchant functions -----------------------------------------------------------------------

create function public.workspace_program_get(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return kma_internal.program_state(p_workspace_id, kma_internal.analytics_require_workspace(p_workspace_id));
end $$;

-- The agreement generated from the saved form, and the hash that stands for it.
create function public.workspace_program_agreement(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.affiliate_programs;
  c record;
begin
  perform kma_internal.analytics_require_workspace(p_workspace_id);
  p := kma_internal.program_of(p_workspace_id);
  select * into c from kma_internal.program_check(p);
  return jsonb_build_object('agreement', c.agreement, 'sha256', c.sha256, 'complete', c.agreement is not null);
end $$;

-- Save the form. Creates the draft the first time.
create function public.workspace_program_save(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_fields constant text[] := array['name', 'category', 'tagline', 'logo_path', 'landing_url', 'commission_type',
    'commission_rate_bps', 'commission_fixed_minor', 'currency', 'commission_duration', 'commission_months',
    'attribution_window_days', 'hold_days', 'minimum_payout_minor', 'approval_mode', 'marketplace_listed', 'extra_terms'];
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

-- The merchant opened the agreement and read it to the end. p_sha256 is the hash they were
-- shown; it only counts while it is still the hash of the current text.
create function public.workspace_program_mark_agreement_read(p_workspace_id uuid, p_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_before public.affiliate_programs := kma_internal.program_for_update(p_workspace_id);
  v_saved public.affiliate_programs;
  c record;
  v_now timestamptz := clock_timestamp();
begin
  select * into c from kma_internal.program_check(v_before);
  if v_before.id is null or c.sha256 is null then
    perform kma_internal.program_fail('program_incomplete', 'Finish the form before reading the agreement');
  elsif v_before.status = 'in_review' then
    perform kma_internal.program_fail('program_in_review', 'The program is in review');
  elsif p_sha256 is distinct from c.sha256 then
    perform kma_internal.program_fail('agreement_not_read', 'The agreement changed. Open it again');
  end if;
  update public.affiliate_programs set
    agreement_read_sha256 = c.sha256, agreement_read_at = v_now,
    revision = revision + 1, updated_by = auth.uid(), updated_at = v_now
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit('affiliate_program_agreement_read', 'system', v_before, v_saved);
  return kma_internal.program_state(p_workspace_id, v_role);
end $$;

-- The Publish button. A first listing goes to review; a published program's changed terms
-- become the next version at once.
create function public.workspace_program_submit(p_workspace_id uuid, p_revision integer) returns jsonb
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

-- Pause a live program, or resume one the merchant or a Stripe disconnect paused.
create function public.workspace_program_set_status(p_workspace_id uuid, p_status text, p_revision integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_now timestamptz := clock_timestamp();
begin
  if p_status is null or p_status not in ('paused', 'live') then
    perform kma_internal.program_fail('invalid_status', 'A program can be paused or resumed');
  end if;
  perform kma_internal.program_lock_stripe(p_workspace_id);
  v_before := kma_internal.program_for_update(p_workspace_id);
  if v_before.id is null then
    perform kma_internal.program_fail('status_not_allowed', 'There is no program to pause or resume');
  end if;
  perform kma_internal.program_require_revision(v_before, p_revision);
  if p_status = 'paused' then
    if v_before.status <> 'live' then
      perform kma_internal.program_fail('status_not_allowed', 'Only a live program can be paused');
    end if;
  elsif v_before.status <> 'paused' then
    perform kma_internal.program_fail('status_not_allowed', 'Only a paused program can be resumed');
  elsif v_before.pause_reason = 'admin' then
    perform kma_internal.program_fail('program_paused_by_admin', 'KissMyApps paused this program');
  elsif kma_internal.workspace_stripe_connection(p_workspace_id) is null then
    perform kma_internal.program_fail('stripe_not_connected', 'Connect Stripe before resuming');
  end if;
  update public.affiliate_programs set
    status = p_status, pause_reason = case when p_status = 'paused' then 'merchant' end,
    revision = revision + 1, updated_by = auth.uid(), updated_at = v_now
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit(
    case when p_status = 'paused' then 'affiliate_program_paused' else 'affiliate_program_resumed' end, 'system', v_before, v_saved);
  return kma_internal.program_state(p_workspace_id, v_role);
end $$;

-- KissMyApps review ------------------------------------------------------------------------

-- One row of the review screen: the program, who it belongs to and what creators would sign.
-- A published program shows the agreement that is in force; the others show the one the
-- saved form generates now.
create function kma_internal.program_review_json(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select kma_internal.program_json(p) || jsonb_build_object(
    'workspace_id', p.workspace_id,
    'workspace_name', (select w.name from public.analytics_workspaces w where w.id = p.workspace_id),
    'brand_name', s.connection->>'business_name',
    'stripe_account_id', s.connection->>'account_id',
    'stripe_country', s.connection->>'country',
    'agreement', coalesce(
      (select t.agreement from public.affiliate_program_terms t
        where t.program_id = p.id and t.version = p.live_terms_version),
      kma_internal.program_agreement(kma_internal.program_terms(p))))
  from (select kma_internal.workspace_stripe_connection(p.workspace_id) as connection) s
$$;

-- Programs waiting for review, oldest first, then the 20 most recently reviewed.
create function public.list_admin_program_reviews() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'review affiliate programs');
  return jsonb_build_object('programs', coalesce((
    select jsonb_agg(kma_internal.program_review_json(q.p) order by q.waiting desc, q.position)
    from (
      (select p, true as waiting, row_number() over (order by p.submitted_at, p.id) as position
        from public.affiliate_programs p where p.status = 'in_review')
      union all
      (select p, false, row_number() over (order by p.reviewed_at desc, p.id)
        from public.affiliate_programs p
        where p.status in ('live', 'paused', 'changes_requested') and p.reviewed_at is not null
        order by p.reviewed_at desc, p.id limit 20)
    ) q), '[]'::jsonb));
end $$;

-- The program named in an admin request, locked together with its workspace's Stripe
-- connection. Raises program_not_found.
create function kma_internal.program_for_review(p_input jsonb, p_keys text[]) returns public.affiliate_programs
language plpgsql volatile set search_path = '' as $$
declare
  p public.affiliate_programs;
  v_id uuid;
  v_workspace uuid;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k <> all(p_keys))
    or (p_input ? 'note' and jsonb_typeof(p_input->'note') not in ('string', 'null')) then
    perform kma_internal.program_fail('invalid_input', 'The request has fields that are not allowed');
  end if;
  v_id := kma_internal.workspace_stripe_uuid(p_input->>'program_id');
  if v_id is null then
    perform kma_internal.program_fail('invalid_program_id', 'program_id must be a UUID');
  end if;
  select workspace_id into v_workspace from public.affiliate_programs where id = v_id;
  if v_workspace is null then
    perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
  end if;
  perform kma_internal.program_lock_stripe(v_workspace);
  perform kma_internal.program_lock(v_workspace);
  select * into p from public.affiliate_programs where id = v_id for update;
  return p;
end $$;

-- An optional note of 5 to 1000 characters, or null.
create function kma_internal.program_review_note(p_input jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_note text := nullif(btrim(coalesce(p_input->>'note', ''), E' \t\r\n'), '');
begin
  if length(v_note) not between 5 and 1000 then
    perform kma_internal.program_fail('invalid_note', 'Write a note of 5 to 1000 characters');
  end if;
  return v_note;
end $$;

-- A product slug for a newly approved program: the program's own, or -2, -3 ... when an
-- older product already has it.
create function kma_internal.program_product_slug(p_slug text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_slug text := p_slug;
  v_count integer := 1;
begin
  perform pg_advisory_xact_lock(hashtextextended('affiliate-program-product-slug', 0));
  while exists (select 1 from public.products where slug = v_slug) loop
    v_count := v_count + 1;
    v_slug := p_slug || '-' || v_count;
  end loop;
  return v_slug;
end $$;

-- Approve the first listing or send it back with a note.
create function public.review_admin_program(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_note text;
  v_product uuid;
  v_funnel uuid;
  v_version integer;
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

  if kma_internal.workspace_stripe_connection(v_before.workspace_id) is null then
    perform kma_internal.program_fail('stripe_not_connected', 'The workspace no longer has a connected Stripe account');
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

-- KissMyApps pauses a live program, or lifts its own pause. A program whose Stripe account
-- was disconnected meanwhile stays paused for that reason until the merchant reconnects.
create function public.set_admin_program_status(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_note text;
  v_status text;
  v_connected boolean;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'pause affiliate programs');
  v_before := kma_internal.program_for_review(p_input, array['program_id', 'status', 'note']);
  v_status := p_input->>'status';
  if jsonb_typeof(p_input->'status') is distinct from 'string' or v_status not in ('paused', 'live') then
    perform kma_internal.program_fail('invalid_status', 'Choose paused or live');
  end if;
  v_note := kma_internal.program_review_note(p_input);
  if (v_status = 'paused' and v_before.status <> 'live')
    or (v_status = 'live' and (v_before.status <> 'paused' or v_before.pause_reason <> 'admin')) then
    perform kma_internal.program_fail('status_not_allowed',
      'Only a live program can be paused, and only a pause by KissMyApps can be lifted');
  end if;
  v_connected := kma_internal.workspace_stripe_connection(v_before.workspace_id) is not null;
  update public.affiliate_programs set
    status = case when v_status = 'live' and v_connected then 'live' else 'paused' end,
    pause_reason = case when v_status = 'paused' then 'admin' when not v_connected then 'stripe_disconnected' end,
    -- The merchant sees why KissMyApps paused the program, when a reason was given.
    review_note = case when v_status = 'paused' then v_note end,
    revision = revision + 1, updated_at = v_now
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit(
    case when v_status = 'paused' then 'affiliate_program_admin_paused' else 'affiliate_program_admin_pause_lifted' end,
    'admin', v_before, v_saved, v_note);
  return jsonb_build_object('program_id', v_saved.id, 'status', v_saved.status, 'pause_reason', v_saved.pause_reason);
end $$;

-- Stripe disconnected ------------------------------------------------------------------------
-- Sales can no longer be seen, so the workspace's live program pauses. Reconnecting does
-- not resume it: the merchant does.

create function kma_internal.pause_programs_on_stripe_disconnect() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_now timestamptz := clock_timestamp();
begin
  for v_before in
    select p.* from public.affiliate_programs p
    join public.merchant_businesses b on b.workspace_id = p.workspace_id
    where b.id = old.merchant_id and p.status = 'live'
    for update of p
  loop
    update public.affiliate_programs set
      status = 'paused', pause_reason = 'stripe_disconnected',
      revision = revision + 1, updated_at = v_now
    where id = v_before.id returning * into v_saved;
    perform kma_internal.program_audit('affiliate_program_stripe_paused', 'system', v_before, v_saved);
  end loop;
  return null;
end $$;

create trigger merchant_connections_pause_programs
  after update of status on public.merchant_connections
  for each row when (old.livemode and old.status = 'active' and new.status <> 'active')
  execute function kma_internal.pause_programs_on_stripe_disconnect();

-- Who may call what ------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal' and (p.proname like 'program\_%' or p.proname = 'pause_programs_on_stripe_disconnect')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
  public.can_manage_program_logo(text),
  public.workspace_program_get(uuid),
  public.workspace_program_agreement(uuid),
  public.workspace_program_save(uuid, jsonb),
  public.workspace_program_mark_agreement_read(uuid, text),
  public.workspace_program_submit(uuid, integer),
  public.workspace_program_set_status(uuid, text, integer),
  public.list_admin_program_reviews(),
  public.review_admin_program(jsonb),
  public.set_admin_program_status(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.can_manage_program_logo(text),
  public.workspace_program_get(uuid),
  public.workspace_program_agreement(uuid),
  public.workspace_program_save(uuid, jsonb),
  public.workspace_program_mark_agreement_read(uuid, text),
  public.workspace_program_submit(uuid, integer),
  public.workspace_program_set_status(uuid, text, integer),
  public.list_admin_program_reviews(),
  public.review_admin_program(jsonb),
  public.set_admin_program_status(jsonb)
to authenticated;

commit;

-- Attribution Phase 2 and affiliate self-serve Phase 7: app installs. The storage only.
--
-- An app install is matched, on the app's first launch, to the link click that brought it:
-- the link that opened the app, the click ID Google Play hands back in the install referrer,
-- an Apple Ads token, a click ID the landing page put on the clipboard, or, later, a web
-- click of the same signed-in person. Otherwise it is organic. Each install keeps how it was
-- matched, so every number can say whether it is exact.
--
-- A link that opens an app that is already installed is a re-engagement: it does not change
-- where the person was first acquired.
--
-- A creator's link for an app program sends people through the merchant's smart link with
-- the creator's click (kma_click) on it, so an install matched to that smart-link click also
-- names the creator, and the program's rewards engine can pay for the install.
--
-- Nothing here acts by itself, and nothing is read until a project turns attribution on.
begin;

-- A link opened inside the app is recorded by the app's own call, not by the link service.
alter table public.attribution_clicks drop constraint attribution_clicks_destination_check;
alter table public.attribution_clicks add constraint attribution_clicks_destination_check
  check (destination in ('app_store', 'play_store', 'web', 'custom', 'page', 'app'));

-- The iPhone landing page whose "Get the app" button puts the click ID on the clipboard, for
-- apps that turned clipboard handoff on in their SDK.
alter table public.attribution_settings
  add column ios_clipboard_handoff boolean not null default false;

-- One row per person: the first launch of the app, and where it came from.
create table public.attribution_installs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  -- Deleting a person deletes their attribution, as for every other analytics row.
  person_id uuid not null references public.analytics_people(id) on delete cascade,
  environment text not null check (environment in ('production', 'development')),
  platform text not null check (platform in ('ios', 'android')),
  installed_at timestamptz not null,
  received_at timestamptz not null default now(),
  session_key text check (length(session_key) between 1 and 100),
  app_version text check (length(app_version) between 1 and 40),
  -- The SDK's SHA-256 of identifierForVendor or ANDROID_ID, hashed again with the project, so
  -- nothing can be joined across merchants. It finds a reinstall of the same phone.
  device_hash text check (device_hash ~ '^[0-9a-f]{64}$'),
  method text not null check (method in (
    'link_open', 'install_referrer', 'apple_ads', 'clipboard', 'login', 'organic', 'reinstall')),
  exact boolean not null,
  -- The winning click. A plain value: raw clicks are deleted after 90 days, installs are not.
  click_id text check (click_id ~ '^[A-Za-z0-9_-]{16,40}$'),
  link_id uuid references public.attribution_links(id) on delete set null,
  source text check (length(source) between 1 and 100),
  campaign text check (length(campaign) between 1 and 200),
  channel text check (length(channel) between 1 and 100),
  adset text check (length(adset) between 1 and 200),
  ad text check (length(ad) between 1 and 200),
  -- Apple's answer for an Apple Ads install: campaign, ad group and keyword IDs, never a person.
  apple_ads jsonb check (apple_ads is null or jsonb_typeof(apple_ads) = 'object'),
  -- The earlier install this one repeats (same phone, inside the reattribution window).
  reinstall_of uuid references public.attribution_installs(id) on delete set null,
  -- counted; flagged (counts, marked for review); rejected (never counts, never paid).
  verdict text not null default 'counted' check (verdict in ('counted', 'flagged', 'rejected')),
  fraud_reason text check (fraud_reason in ('click_after_install', 'too_fast')),
  -- The creator's click (public.clicks.public_click_id) carried by the winning smart-link click.
  creator_click text check (creator_click ~ '^[0-9a-f]{48}$'),
  deep_link_value text check (length(deep_link_value) between 1 and 500),
  deep_link_params jsonb not null default '{}'::jsonb check (jsonb_typeof(deep_link_params) = 'object'),
  deep_link_delivered_at timestamptz,
  -- When the match last changed (a later login can turn an organic install into a matched one).
  matched_at timestamptz not null default now(),
  constraint attribution_install_once unique (project_id, person_id),
  constraint attribution_install_reinstall check ((method = 'reinstall') = (reinstall_of is not null)),
  constraint attribution_install_fraud check ((verdict = 'counted') = (fraud_reason is null)),
  constraint attribution_install_click check (method not in ('link_open', 'install_referrer', 'clipboard', 'login')
    or click_id is not null)
);
create index attribution_installs_project on public.attribution_installs(project_id, installed_at desc);
create index attribution_installs_device on public.attribution_installs(project_id, device_hash, installed_at desc)
  where device_hash is not null;
create index attribution_installs_click on public.attribution_installs(click_id) where click_id is not null;
create index attribution_installs_link on public.attribution_installs(link_id, installed_at) where link_id is not null;
create index attribution_installs_organic on public.attribution_installs(installed_at)
  where method = 'organic';

-- A link that opened the app for someone who already had it.
create table public.attribution_engagements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  person_id uuid not null references public.analytics_people(id) on delete cascade,
  click_id text not null check (click_id ~ '^[A-Za-z0-9_-]{16,40}$'),
  link_id uuid references public.attribution_links(id) on delete set null,
  opened_at timestamptz not null,
  ends_at timestamptz not null,
  source text check (length(source) between 1 and 100),
  campaign text check (length(campaign) between 1 and 200),
  channel text check (length(channel) between 1 and 100),
  creator_click text check (creator_click ~ '^[0-9a-f]{48}$'),
  created_at timestamptz not null default now(),
  check (ends_at > opened_at)
);
create index attribution_engagements_person on public.attribution_engagements(person_id, opened_at desc);
create index attribution_engagements_link on public.attribution_engagements(link_id, opened_at) where link_id is not null;

-- Where a person was first acquired, so Users can show and filter it.
alter table public.analytics_people
  add column acquisition_source text check (length(acquisition_source) between 1 and 100),
  add column acquisition_campaign text check (length(acquisition_campaign) between 1 and 200),
  add column acquisition_method text check (acquisition_method in (
    'link_open', 'install_referrer', 'apple_ads', 'clipboard', 'login', 'organic', 'reinstall')),
  add column installed_at timestamptz;

-- Called after an install is written or its match changes. Affiliate Phase 7 replaces it to
-- credit the creator; until then it does nothing.
create function kma_internal.attribution_install_matched(p_install uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform p_install;
end $$;
revoke all on function kma_internal.attribution_install_matched(uuid) from public, anon, authenticated, service_role;

alter table public.attribution_installs enable row level security;
alter table public.attribution_engagements enable row level security;
revoke all on public.attribution_installs, public.attribution_engagements
  from public, anon, authenticated, service_role;

commit;

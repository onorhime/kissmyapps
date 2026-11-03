-- Provider-free test of the attribution foundation: a project turns attribution on with a
-- subdomain of the link root, describes its apps and website, adds a domain of its own, and
-- the link service learns what each host should answer. Roles decide who changes what.
begin;
set local time zone 'UTC';
create temporary table attribution_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution assertion failed: %', label; end if;
  insert into attribution_assertions values (label);
end $$;
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
create function pg_temp.patch(p jsonb) returns jsonb language sql as $$
  select public.attribution_update(pg_temp.q('project'), p)
$$;
create function pg_temp.patch_fails(p jsonb) returns text language sql as $$
  select pg_temp.fails(format('select public.attribution_update(%L, %L)', pg_temp.q('project'), p))
$$;
create function pg_temp.domain(view jsonb, h text) returns jsonb language sql as $$
  select x from jsonb_array_elements(view->'domains') x where x->>'host' = h
$$;
grant all on qa, attribution_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1000000-0000-4000-8000-000000000001', 'owner@speaksix.example', now(), '{"full_name":"Ada Owner","company":"SpeakSix"}'::jsonb),
  ('e1000000-0000-4000-8000-000000000002', 'analyst@speaksix.example', now(), '{}'),
  ('e1000000-0000-4000-8000-000000000003', 'developer@speaksix.example', now(), '{}'),
  ('e1000000-0000-4000-8000-000000000004', 'stranger@elsewhere.example', now(), '{}');

-- Closed by default ------------------------------------------------------------------------
select pg_temp.check(not has_table_privilege('authenticated', 'public.attribution_settings', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_domains', 'select')
  and not has_table_privilege('anon', 'public.attribution_config', 'select'), 'members read attribution only through the console functions');
select pg_temp.check(has_function_privilege('authenticated', 'public.attribution_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_get(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_enable(uuid,text)', 'execute'), 'only signed-in members call the console functions');
select pg_temp.check(has_function_privilege('service_role', 'public.attribution_link_host(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_link_host(text)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_link_host(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_link_seen(text)', 'execute'), 'only the link service reads hosts');

-- A workspace with a project, an analyst and a developer -------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'SpeakSix', array['ios', 'android', 'web'], 'Africa/Lagos') r)
insert into qa select 'project', r->'project'->>'id' from created;
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["http://localhost:5173","https://speaksix.app"]}');
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@speaksix.example', 'analyst');
select public.analytics_invite_member(pg_temp.q('workspace'), 'developer@speaksix.example', 'developer');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
select public.analytics_bootstrap();
-- Someone else's workspace and project.
select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
insert into qa select 'other_workspace', public.analytics_bootstrap('Elsewhere')->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('other_workspace'), 'Elsewhere', array['web'], 'UTC') r)
insert into qa select 'other', r->'project'->>'id' from created;

-- Before it is on ------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select pg_temp.check((select v->>'enabled' = 'false' and v->>'ever_enabled' = 'false' and v->'settings' = 'null'::jsonb
  and v->'domains' = '[]'::jsonb and v->>'link_root' = 'go.kissmyapps.dev' and v->>'cname_target' = 'cname.go.kissmyapps.dev'
  and v->'setup' = '{"apps":false,"domain":false,"sdk":false,"conversions":false,"partners":false,"skan":false}'::jsonb
  from (select public.attribution_get(pg_temp.q('project')) v) t), 'a project starts with attribution off and nothing set up');
select pg_temp.check((public.analytics_project_settings(pg_temp.q('project'))#>>'{project,attribution_enabled}') = 'false',
  'the project says attribution is off');
select pg_temp.check((select c = '{"subdomain":"speaksix","host":"speaksix.go.kissmyapps.dev","available":true,"reason":null}'::jsonb
  from (select public.attribution_check_subdomain(pg_temp.q('project'), ' SpeakSix ') c) t), 'a free name is offered as a host under the link root');
select pg_temp.check((select bool_and((public.attribution_check_subdomain(pg_temp.q('project'), x)->>'available') = 'false')
  from unnest(array['ab', '-speak', 'speak-', 'spe--ak', 'speak.six', 'speak_six', repeat('a', 41), '']) x), 'names that are too short, too long or badly formed are refused');
select pg_temp.check((select bool_and(public.attribution_check_subdomain(pg_temp.q('project'), x)->>'reason' like 'That name is kept%')
  from unnest(array['www', 'api', 'cname', 'admin', 'kissmyapps']) x), 'names kept for KissMyApps are refused');
select pg_temp.check(pg_temp.fails(format('select public.attribution_update(%L, ''{}'')', pg_temp.q('project'))) like '22023%Turn on attribution%',
  'settings wait until attribution is on');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''go.speaksix.app'')', pg_temp.q('project'))) like '22023%Turn on attribution%',
  'so do domains');

-- Who may turn it on -------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select pg_temp.check((public.attribution_get(pg_temp.q('project'))->>'enabled') = 'false', 'analysts can see attribution');
select pg_temp.check(pg_temp.fails(format('select public.attribution_enable(%L, ''speaksix'')', pg_temp.q('project'))) like '42501%', 'analysts cannot turn it on');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.attribution_enable(%L, ''speaksix'')', pg_temp.q('project'))) like '42501%', 'nor can developers');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
select pg_temp.check(pg_temp.fails(format('select public.attribution_get(%L)', pg_temp.q('project'))) like 'P0002%', 'outsiders cannot see it');
select pg_temp.check(pg_temp.fails(format('select public.attribution_enable(%L, ''speaksix'')', pg_temp.q('project'))) like 'P0002%', 'or turn it on');

-- Turning it on ----------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.fails(format('select public.attribution_enable(%L, ''www'')', pg_temp.q('project'))) like '22023%kept for KissMyApps%',
  'turning on needs a usable name');
select pg_temp.check((public.attribution_get(pg_temp.q('project'))->>'ever_enabled') = 'false', 'a refused name leaves attribution off');
insert into qa select 'on', public.attribution_enable(pg_temp.q('project'), 'SpeakSix')::text;
select pg_temp.check((select v->>'enabled' = 'true' and v->>'ever_enabled' = 'true'
  and jsonb_array_length(v->'domains') = 1 and v#>>'{domains,0,host}' = 'speaksix.go.kissmyapps.dev'
  and v#>>'{domains,0,kind}' = 'kma' and v#>>'{domains,0,status}' = 'live'
  from (select value::jsonb v from qa where key = 'on') t), 'turning on reserves the project''s subdomain');
select pg_temp.check((select v#>>'{settings,web_url}' = 'https://speaksix.app/' and v#>>'{settings,click_lookback_days}' = '7'
  and v#>>'{settings,currency}' = 'USD' and v#>'{settings,android_sha256}' = '[]'::jsonb
  from (select value::jsonb v from qa where key = 'on') t), 'the website starts as the project''s allowed https site, with standard windows');
select pg_temp.check((select v#>>'{setup,domain}' = 'true' and v#>>'{setup,apps}' = 'false'
  from (select value::jsonb v from qa where key = 'on') t), 'the domain step is done; the apps step waits for iOS and Android');
select pg_temp.check((public.analytics_project_settings(pg_temp.q('project'))#>>'{project,attribution_enabled}') = 'true',
  'the project says attribution is on');
select pg_temp.check((select bool_or((p->>'attribution_enabled')::boolean) from jsonb_array_elements(public.analytics_bootstrap()->'workspaces'->0->'projects') p),
  'and so does the project list');
select pg_temp.check((public.attribution_check_subdomain(pg_temp.q('project'), 'speaksix')->>'available') = 'true',
  'a project''s own name stays available to it');

select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
select pg_temp.check((select c->>'available' = 'false' and c->>'reason' like 'Another project already uses%'
  from (select public.attribution_check_subdomain(pg_temp.q('other'), 'speaksix') c) t), 'a taken name is not offered to another project');
select pg_temp.check(pg_temp.fails(format('select public.attribution_enable(%L, ''speaksix'')', pg_temp.q('other'))) like '22023%Another project%',
  'and cannot be taken');
select public.attribution_enable(pg_temp.q('other'), 'elsewhere');

-- Apps and website --------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.patch_fails('{"web_url":"https://speaksix.app"}') like '42501%', 'analysts cannot change settings');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
insert into qa select 'apps', pg_temp.patch(jsonb_build_object(
  'ios_app_store_id', ' id1234567890 ', 'ios_bundle_id', 'app.speaksix.ios', 'ios_team_id', 'abcde12345',
  'android_package', 'app.speaksix', 'web_url', 'SpeakSix.APP/Start?ref=Links',
  'android_sha256', jsonb_build_array(
    lower(repeat('AB', 32)),
    regexp_replace(repeat('AB', 32), '(..)(?!$)', '\1:', 'g'),
    '  ',
    repeat('0F', 16) || repeat('a1', 16))))::text;
select pg_temp.check((select v#>>'{settings,ios_app_store_id}' = '1234567890' and v#>>'{settings,ios_team_id}' = 'ABCDE12345'
  and v#>>'{settings,ios_bundle_id}' = 'app.speaksix.ios' and v#>>'{settings,android_package}' = 'app.speaksix'
  from (select value::jsonb v from qa where key = 'apps') t), 'developers describe the apps; App Store and Team IDs are tidied');
select pg_temp.check((select v#>'{settings,android_sha256}' = jsonb_build_array(
    regexp_replace(repeat('AB', 32), '(..)(?!$)', '\1:', 'g'),
    regexp_replace(repeat('0F', 16) || repeat('A1', 16), '(..)(?!$)', '\1:', 'g'))
  from (select value::jsonb v from qa where key = 'apps') t), 'fingerprints are written the way Android wants them, once each');
select pg_temp.check((select v#>>'{settings,web_url}' = 'https://speaksix.app/Start?ref=Links'
  from (select value::jsonb v from qa where key = 'apps') t), 'a website typed without https gets it, and keeps its path as typed');
select pg_temp.check((select v#>>'{setup,apps}' = 'true' from (select value::jsonb v from qa where key = 'apps') t),
  'with iOS, Android and the website described, the apps step is done');
select pg_temp.check((select v#>>'{setup,apps}' = 'false' from (select pg_temp.patch('{"android_sha256":[]}') v) t),
  'Android without a fingerprint is not ready');
select pg_temp.patch(jsonb_build_object('android_sha256', jsonb_build_array(repeat('ab', 32))));

select pg_temp.check(pg_temp.patch_fails('{"ios_app_store_id":"speaksix"}') like '22023%App Store ID%', 'App Store IDs are numbers');
select pg_temp.check(pg_temp.patch_fails('{"ios_bundle_id":"speaksix"}') like '22023%bundle ID%', 'bundle IDs have dots');
select pg_temp.check(pg_temp.patch_fails('{"ios_team_id":"ABC"}') like '22023%Team ID%', 'Team IDs are 10 characters');
select pg_temp.check(pg_temp.patch_fails('{"android_package":"1app.x"}') like '22023%package name%', 'package names start with a letter');
select pg_temp.check(pg_temp.patch_fails('{"android_sha256":["AB:CD"]}') like '22023%fingerprint%', 'fingerprints are SHA-256');
select pg_temp.check(pg_temp.patch_fails('{"android_sha256":"AB"}') like '22023%', 'fingerprints come as a list');
select pg_temp.check(pg_temp.patch_fails('{"web_url":"http://speaksix.app"}') like '22023%https://%', 'websites use https');
select pg_temp.check(pg_temp.patch_fails('{"web_url":"https://speak six.app"}') like '22023%', 'websites are whole addresses');
select pg_temp.check(pg_temp.patch_fails('{"click_lookback_days":31}') like '22023%1 to 30 days%', 'the click window is at most 30 days');
select pg_temp.check(pg_temp.patch_fails('{"click_lookback_days":"7"}') like '22023%', 'windows are numbers');
select pg_temp.check(pg_temp.patch_fails('{"view_lookback_hours":2.5}') like '22023%', 'windows are whole numbers');
select pg_temp.check(pg_temp.patch_fails('{"view_through_enabled":"yes"}') like '22023%', 'view-through is on or off');
select pg_temp.check(pg_temp.patch_fails('{"currency":"dollars"}') like '22023%currency%', 'currencies are three-letter codes');
select pg_temp.check(pg_temp.patch_fails('{"link_root":"evil.example"}') like '22023%Unknown%', 'only known settings change');
select pg_temp.check(pg_temp.patch_fails('[]') like '22023%', 'settings come as an object');
select pg_temp.check((select v#>>'{settings,click_lookback_days}' = '14' and v#>>'{settings,view_through_enabled}' = 'true'
  and v#>>'{settings,view_lookback_hours}' = '12' and v#>>'{settings,reengagement_days}' = '60'
  and v#>>'{settings,reattribution_days}' = '180' and v#>>'{settings,currency}' = 'NGN'
  and v#>>'{settings,ios_bundle_id}' = 'app.speaksix.ios'
  from (select pg_temp.patch('{"click_lookback_days":14,"view_through_enabled":true,"view_lookback_hours":12,"reengagement_days":60,"reattribution_days":180,"currency":"ngn"}') v) t),
  'windows and currency change, and what was not sent stays');
select pg_temp.check((select v#>>'{settings,ios_app_store_id}' is null from (select pg_temp.patch('{"ios_app_store_id":""}') v) t),
  'an empty value clears a setting');
select pg_temp.patch('{"ios_app_store_id":"1234567890"}');

-- Domains of the merchant's own ------------------------------------------------------------
insert into qa select 'custom', public.attribution_add_domain(pg_temp.q('project'), ' https://Go.SpeakSix.app/start ')::text;
select pg_temp.check((select d->>'kind' = 'custom' and d->>'status' = 'waiting' and d->>'verified_at' is null
  from (select pg_temp.domain(value::jsonb, 'go.speaksix.app') d from qa where key = 'custom') t), 'a domain of the merchant''s own waits for its DNS');
select pg_temp.check((select (value::jsonb)#>>'{domains,0,kind}' = 'kma' from qa where key = 'custom'), 'the KissMyApps subdomain is listed first');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''links.go.kissmyapps.dev'')', pg_temp.q('project'))) like '22023%subdomain is already set up%',
  'names under the link root come from the subdomain, not here');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''partners.kissmyapps.dev'')', pg_temp.q('project'))) like '22023%your company owns%',
  'KissMyApps domains cannot be added');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''speaksix'')', pg_temp.q('project'))) like '22023%go.yourbrand.com%',
  'a domain has a dot');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''go.speaksix.app'')', pg_temp.q('project'))) like '23505%',
  'a domain is added once');
select public.attribution_add_domain(pg_temp.q('project'), x) from unnest(array['l1.speaksix.app', 'l2.speaksix.app', 'l3.speaksix.app', 'l4.speaksix.app']) x;
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''l5.speaksix.app'')', pg_temp.q('project'))) like '22023%up to 5%',
  'a project has up to 5 domains of its own');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''GO.speaksix.app'')', pg_temp.q('other'))) like '23505%already connected%',
  'another project cannot add a domain that is taken');
select pg_temp.check(pg_temp.fails(format('select public.attribution_remove_domain(%L)', (select id from public.attribution_domains where host = 'l4.speaksix.app'))) like 'P0002%',
  'outsiders cannot remove a project''s domain');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.fails(format('select public.attribution_add_domain(%L, ''l5.speaksix.app'')', pg_temp.q('project'))) like '42501%',
  'analysts cannot add domains');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
select pg_temp.check((select jsonb_array_length(v->'domains') = 5 from (select public.attribution_remove_domain(
  (select id from public.attribution_domains where host = 'l4.speaksix.app')) v) t), 'developers remove a domain');
select pg_temp.check(pg_temp.fails(format('select public.attribution_remove_domain(%L)', (select id from public.attribution_domains where host = 'speaksix.go.kissmyapps.dev'))) like '22023%rename it%',
  'the KissMyApps subdomain stays');
select pg_temp.check(pg_temp.fails(format('select public.attribution_remove_domain(%L)', gen_random_uuid())) like 'P0002%', 'unknown domains are not found');

-- What the link service sees ----------------------------------------------------------------
select pg_temp.as_user(null);
set local role service_role;
select pg_temp.check((select h = jsonb_build_object('host', 'speaksix.go.kissmyapps.dev', 'project_id', pg_temp.q('project'), 'kind', 'kma',
    'enabled', true, 'ios_app_ids', '["ABCDE12345.app.speaksix.ios"]'::jsonb,
    'android', jsonb_build_object('package', 'app.speaksix', 'sha256', jsonb_build_array(regexp_replace(repeat('AB', 32), '(..)(?!$)', '\1:', 'g'))),
    'web_url', 'https://speaksix.app/Start?ref=Links')
  from (select public.attribution_link_host('SpeakSix.Go.KissMyApps.dev.') h) t), 'a host gives its project, apps and website');
select pg_temp.check(public.attribution_link_host('nobody.go.kissmyapps.dev') is null, 'an unknown host gives nothing');
select pg_temp.check((select h->'ios_app_ids' = '[]'::jsonb and h->'android' = 'null'::jsonb and h->>'web_url' is null
  from (select public.attribution_link_host('elsewhere.go.kissmyapps.dev') h) t), 'a project without apps gives no app files');
select pg_temp.check(public.attribution_link_seen('go.speaksix.app') and not public.attribution_link_seen('go.speaksix.app'),
  'a request over HTTPS marks a domain live, at most hourly');
select pg_temp.check(not public.attribution_link_seen('nobody.example'), 'an unknown host is not marked');
reset role;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
select pg_temp.check((select d->>'status' = 'live' and d->>'verified_at' is not null and d->>'last_seen_at' is not null
  from (select pg_temp.domain(public.attribution_get(pg_temp.q('project')), 'go.speaksix.app') d) t), 'the console shows the domain live');

-- Renaming the subdomain -------------------------------------------------------------------
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_subdomain(%L, ''speak6'')', pg_temp.q('project'))) like '42501%',
  'developers cannot rename the subdomain');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_subdomain(%L, ''elsewhere'')', pg_temp.q('project'))) like '22023%Another project%',
  'a rename cannot take another project''s name');
select pg_temp.check((select pg_temp.domain(v, 'speak6.go.kissmyapps.dev')->>'kind' = 'kma' and pg_temp.domain(v, 'speaksix.go.kissmyapps.dev') is null
  from (select public.attribution_set_subdomain(pg_temp.q('project'), 'speak6') v) t), 'admins rename the subdomain');
set local role service_role;
select pg_temp.check(public.attribution_link_host('speaksix.go.kissmyapps.dev') is null
  and (public.attribution_link_host('speak6.go.kissmyapps.dev')->>'project_id')::uuid = pg_temp.q('project'), 'the old name stops answering');
reset role;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
select pg_temp.check((public.attribution_check_subdomain(pg_temp.q('other'), 'speaksix')->>'available') = 'true', 'and is free again');

-- Turning it off and on again ----------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.attribution_disable(%L)', pg_temp.q('project'))) like '42501%', 'developers cannot turn it off');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select pg_temp.check((select v->>'enabled' = 'false' and v->>'ever_enabled' = 'true' and jsonb_array_length(v->'domains') = 5
  and v#>>'{settings,ios_team_id}' = 'ABCDE12345' and v#>>'{settings,disabled_at}' is not null
  from (select public.attribution_disable(pg_temp.q('project')) v) t), 'turning off keeps settings and domains');
select pg_temp.check((public.analytics_project_settings(pg_temp.q('project'))#>>'{project,attribution_enabled}') = 'false', 'the project says it is off');
set local role service_role;
select pg_temp.check((public.attribution_link_host('speak6.go.kissmyapps.dev')->>'enabled') = 'false', 'the link service hears it is off');
reset role;
select pg_temp.check((select v->>'enabled' = 'true' and v#>>'{settings,disabled_at}' is null
  and pg_temp.domain(v, 'speak6.go.kissmyapps.dev') is not null and jsonb_array_length(v->'domains') = 5
  from (select public.attribution_enable(pg_temp.q('project'), null) v) t), 'turning on again carries on where it was');

-- Moving to a new link root later ------------------------------------------------------------
reset role;
update public.attribution_config set link_root = 'kma.li';
select pg_temp.check((select c->>'host' = 'speak6.kma.li' from (select public.attribution_check_subdomain(pg_temp.q('project'), 'speak6') c) t)
  and (public.attribution_get(pg_temp.q('project'))->>'cname_target') = 'cname.kma.li', 'a new link root is one setting');
select pg_temp.check(pg_temp.domain(public.attribution_get(pg_temp.q('project')), 'speak6.go.kissmyapps.dev') is not null, 'existing hosts keep working');
select pg_temp.check(pg_temp.fails('update public.attribution_config set link_root = ''Not A Host''') like '23514%', 'the link root is a host name');
select pg_temp.check(pg_temp.fails('insert into public.attribution_config(id, link_root) values (false, ''x.example'')') like '23514%', 'there is one link root');

-- Deleting the project deletes its attribution -------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000004');
select public.analytics_delete_project(pg_temp.q('other'), 'Elsewhere');
select pg_temp.check(not exists (select 1 from public.attribution_domains where project_id = pg_temp.q('other'))
  and not exists (select 1 from public.attribution_settings where project_id = pg_temp.q('other')), 'a deleted project takes its domains with it');

select 'ok ' || count(*) || ' merchant attribution assertions' from attribution_assertions;
rollback;

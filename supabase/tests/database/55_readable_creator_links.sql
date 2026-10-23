-- Local transaction-only alias regression: no HTTP/provider/money/email calls.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=extensions,public,pg_catalog;
select no_plan();
create temporary table alias_test_links(affiliate_id uuid,id uuid,legacy text,short_url text,snapshot jsonb);
grant all on pg_temp.alias_test_links to authenticated,service_role;
insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000551','alias-owner@example.invalid',now()),
 ('10000000-0000-4000-8000-000000000552','alias-partner@example.invalid',now()),
 ('10000000-0000-4000-8000-000000000553','alias-other@example.invalid',now());
insert into public.admin_users(user_id,role,active) values('10000000-0000-4000-8000-000000000551','owner',true);
insert into public.affiliates(id,public_name,slug,status) values
 ('30000000-0000-4000-8000-000000000551','José Núñez','partner-aaaaaaaaaaaaaaaaaaaaaaaa','active'),
 ('30000000-0000-4000-8000-000000000552','José Núñez','partner-bbbbbbbbbbbbbbbbbbbbbbbb','active'),
 ('30000000-0000-4000-8000-000000000553','王小明','partner-cccccccccccccccccccccccc','active'),
 ('30000000-0000-4000-8000-000000000554','Анна Иванова','partner-dddddddddddddddddddddddd','active'),
 ('30000000-0000-4000-8000-000000000555','محمد','partner-eeeeeeeeeeeeeeeeeeeeeeee','active'),
 ('30000000-0000-4000-8000-000000000556','A different display name','victory','active'),
 ('30000000-0000-4000-8000-000000000557',repeat('𠮷',60),'partner-ffffffffffffffffffffffff','active');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values
 ('30000000-0000-4000-8000-000000000551','10000000-0000-4000-8000-000000000552','owner',true,false,now()),
 ('30000000-0000-4000-8000-000000000552','10000000-0000-4000-8000-000000000553','owner',true,false,now());
insert into public.products(id,slug,name,status) values('20000000-0000-4000-8000-000000000551','speaksix','SpeakSix','draft');
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default) values
 ('70000000-0000-4000-8000-000000000551','20000000-0000-4000-8000-000000000551','marathon','Marathon','https://marathon.speaksix.com/?campaign=launch','live',true);
insert into public.sources(id,key,name) values('71000000-0000-4000-8000-000000000551','social','Social');
insert into public.campaigns(id,product_id,key,name,status) values('72000000-0000-4000-8000-000000000551','20000000-0000-4000-8000-000000000551','launch','Launch','active');
insert into public.platform_settings(singleton,tracking_base_url,tracking_enabled) values(true,'https://go.kissmyapps.dev',false);
create function pg_temp.alias_admin() returns text language sql as $$select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000551","role":"authenticated","amr":[{"method":"password"}]}',true);$$;
create function pg_temp.alias_partner() returns text language sql as $$select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000552","role":"authenticated","amr":[{"method":"password"}]}',true);$$;
grant execute on function pg_temp.alias_admin(),pg_temp.alias_partner() to authenticated,service_role;
set local role authenticated;
select pg_temp.alias_admin();
select public.set_admin_product_tracking_mode(jsonb_build_object('product_id','20000000-0000-4000-8000-000000000551','mode','tracking_only','expected_updated_at',(select updated_at from public.get_admin_products() where id='20000000-0000-4000-8000-000000000551')));
select public.activate_admin_product('{"product_id":"20000000-0000-4000-8000-000000000551"}');
select public.configure_admin_tracking(jsonb_build_object('base_url','https://go.kissmyapps.dev','enabled',true,'expected_updated_at',public.get_admin_platform_settings()#>>'{tracking,updated_at}'));
do $$declare n integer;r jsonb;begin for n in 551..557 loop
 r:=public.issue_admin_main_link(jsonb_build_object('affiliate_id','30000000-0000-4000-8000-000000000'||n,'product_id','20000000-0000-4000-8000-000000000551'));
 insert into pg_temp.alias_test_links values((r->>'affiliate_id')::uuid,(r->>'id')::uuid,r->>'tracking_url',r->>'short_url',r-array['short_url','environment']);
end loop;end;$$;
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000551'),'https://go.kissmyapps.dev/speaksix/josé-núñez','first real public name has no suffix or opaque ID');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000552'),'https://go.kissmyapps.dev/speaksix/josé-núñez-2','same public name gets unique minimal collision suffix');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000553'),'https://go.kissmyapps.dev/speaksix/王小明','CJK public name is retained');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000554'),'https://go.kissmyapps.dev/speaksix/анна-иванова','Cyrillic public name is retained');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000555'),'https://go.kissmyapps.dev/speaksix/محمد','Arabic public name is retained');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000556'),'https://go.kissmyapps.dev/speaksix/victory','existing custom username is kept independently of display name');
select is((select short_url from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000557'),'https://go.kissmyapps.dev/speaksix/'||repeat('𠮷',48),'long astral-letter names are bounded by characters, not bytes');
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000551","product_id":"20000000-0000-4000-8000-000000000551"}')->>'short_url','https://go.kissmyapps.dev/speaksix/josé-núñez','repeated main-link issuance returns the same friendly address');
select is((select count(*) from jsonb_array_elements(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000551')->'main_links') as link where link->>'short_url' like 'https://go.kissmyapps.dev/speaksix/%'),7::bigint,'admin configuration exposes all current readable addresses');
select pg_temp.alias_partner();
select is((select main_short_url from public.partner_product_directory where id='20000000-0000-4000-8000-000000000551'),'https://go.kissmyapps.dev/speaksix/josé-núñez','partner product directory includes readable main URL');
select is(public.partner_link_short_url((select id from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000552')),null,'foreign partner link ID cannot reveal an alias');
select set_config('qa.alias.input',jsonb_build_object('name','Instagram Bio','product_id','20000000-0000-4000-8000-000000000551','funnel_id','70000000-0000-4000-8000-000000000551','source_id','71000000-0000-4000-8000-000000000551','campaign_id','72000000-0000-4000-8000-000000000551','sub1','instagram','sub2','story','sub3','launch')::text,true);
select set_config('qa.alias.derived',(select to_jsonb(link)::text from public.create_partner_link(current_setting('qa.alias.input')::jsonb) as link),true);
select is(current_setting('qa.alias.derived')::jsonb->>'short_url','https://go.kissmyapps.dev/speaksix/josé-núñez/instagram-bio','real create RPC keeps SETOF contract and returns readable campaign address');
select is((select short_url from public.update_partner_link((current_setting('qa.alias.derived')::jsonb->>'id')::uuid,'{"name":"Renamed display label"}')),'https://go.kissmyapps.dev/speaksix/josé-núñez/instagram-bio','rename RPC returns the same immutable short URL');
select is((select short_url from public.set_partner_link_status((current_setting('qa.alias.derived')::jsonb->>'id')::uuid,'paused')),'https://go.kissmyapps.dev/speaksix/josé-núñez/instagram-bio','pause RPC returns the short URL without changing its address');
set local role service_role;
select throws_ok($q$select * from public.register_short_tracking_click('/speaksix/josé-núñez/instagram-bio','{}')$q$,'P0002',null,'paused link alias does not bypass canonical readiness');
set local role authenticated;
select is((select short_url from public.set_partner_link_status((current_setting('qa.alias.derived')::jsonb->>'id')::uuid,'active')),'https://go.kissmyapps.dev/speaksix/josé-núñez/instagram-bio','resume RPC returns same address');
select is((select short_url from public.create_partner_link(current_setting('qa.alias.input')::jsonb||'{"sub1":"another"}')),'https://go.kissmyapps.dev/speaksix/josé-núñez/instagram-bio-2','same campaign name with distinct tracking dimensions gets minimal suffix');
select is((select short_url from public.create_partner_link(current_setting('qa.alias.input')::jsonb||'{"name":"2","sub1":"numeric"}')),'https://go.kissmyapps.dev/speaksix/josé-núñez/2','numeric campaign segment is reserved in shared alias namespace');
set local role service_role;
select set_config('qa.alias.shortclick',(select to_jsonb(click)::text from public.register_short_tracking_click('/speaksix/josé-núñez/instagram-bio',jsonb_build_object('session_id_hash',repeat('a',64),'is_bot',true)) as click),true);
select set_config('qa.alias.oldclick',(select to_jsonb(click)::text from public.register_tracking_click('partner-aaaaaaaaaaaaaaaaaaaaaaaa',split_part(current_setting('qa.alias.derived')::jsonb->>'tracking_url','/',6),jsonb_build_object('session_id_hash',repeat('b',64),'is_bot',true)) as click),true);
select is(current_setting('qa.alias.shortclick')::jsonb->>'destination_url',current_setting('qa.alias.oldclick')::jsonb->>'destination_url','short and legacy URLs resolve the identical saved destination');
reset role;
select ok((select count(*)=2 and count(distinct affiliate_link_id)=1 and bool_and(source_id='71000000-0000-4000-8000-000000000551') and bool_and(campaign_id='72000000-0000-4000-8000-000000000551') and bool_and(sub1='instagram' and sub2='story' and sub3='launch') and bool_and(is_bot) and bool_and(not commercial_eligible) from public.clicks where public_click_id in(current_setting('qa.alias.shortclick')::jsonb->>'click_id',current_setting('qa.alias.oldclick')::jsonb->>'click_id')),'both routes preserve exact attribution dimensions and bot/noncommercial scope');
select ok((select bool_and(to_jsonb(link)=saved.snapshot) from public.affiliate_links as link join alias_test_links saved on saved.id=link.id),'adding aliases leaves all original main-link fields byte-for-byte unchanged');
update public.affiliates set public_name='Renamed display name' where id='30000000-0000-4000-8000-000000000551';
update public.products set slug='speaksix-renamed' where id='20000000-0000-4000-8000-000000000551';
select is(kma_internal.tracking_link_short_url((select id from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000551')),'https://go.kissmyapps.dev/speaksix/josé-núñez','public-name/product-slug edits do not change issued paths');
select throws_ok($q$update kma_internal.tracking_link_aliases set path='/hijack/someone' where link_id=(select id from alias_test_links limit 1)$q$,'P0001','issued readable tracking handles and aliases are immutable','stored alias ownership cannot be reassigned');
update public.affiliate_links set status='archived' where id=(select id from alias_test_links where affiliate_id='30000000-0000-4000-8000-000000000551');
set local role authenticated;
select pg_temp.alias_admin();
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000551","product_id":"20000000-0000-4000-8000-000000000551"}')->>'short_url','https://go.kissmyapps.dev/speaksix/josé-núñez/3','reissued main link cannot hijack archived base path or numeric campaign path');
reset role;
select ok(not has_function_privilege('authenticated','public.register_short_tracking_click(text,jsonb)','EXECUTE') and not has_function_privilege('anon','public.register_short_tracking_click(text,jsonb)','EXECUTE'),'only service can record alias clicks');
select ok(not has_table_privilege('authenticated','kma_internal.tracking_link_aliases','SELECT') and not has_table_privilege('service_role','kma_internal.tracking_link_aliases','UPDATE'),'alias tables are not a browser or service mutation API');
select ok(not has_function_privilege('authenticated','kma_internal.ensure_tracking_link_alias(uuid)','EXECUTE') and not has_function_privilege('authenticated','public.issue_admin_main_link_before_short_urls(jsonb)','EXECUTE'),'private allocation and preserved issuance implementation stay inaccessible');
set local role service_role;
select throws_ok($q$select * from public.register_short_tracking_click('/speaksix/josé-núñez','{}')$q$,'P0002',null,'archived original alias stays unavailable after reissue');
reset role;
-- Authorized prelaunch deletion must preserve address reservations, while the
-- existing delete RPC still removes its permitted demo rows normally.
set local role authenticated;
select set_config('qa.alias.deleted',public.delete_admin_product('{"product_id":"20000000-0000-4000-8000-000000000551","confirmation":"speaksix-renamed"}')::text,true);
reset role;
select ok(not exists(select 1 from public.products where id='20000000-0000-4000-8000-000000000551'),'approved demo product deletion remains functional');
select ok(exists(select 1 from kma_internal.tracking_link_aliases where path='/speaksix/josé-núñez' and link_id is null),'old link path becomes a permanent unresolvable tombstone');
select ok(exists(select 1 from kma_internal.product_tracking_handles where handle='speaksix' and product_id is null),'deleted product handle remains reserved');
insert into public.products(id,slug,name,status) values('20000000-0000-4000-8000-000000000552','speaksix','Different product','draft');
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default) values('70000000-0000-4000-8000-000000000552','20000000-0000-4000-8000-000000000552','next','Next','https://marathon.speaksix.com/new','live',true);
set local role authenticated;
select public.set_admin_product_tracking_mode(jsonb_build_object('product_id','20000000-0000-4000-8000-000000000552','mode','tracking_only','expected_updated_at',(select updated_at from public.get_admin_products() where id='20000000-0000-4000-8000-000000000552')));
select public.activate_admin_product('{"product_id":"20000000-0000-4000-8000-000000000552"}');
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000551","product_id":"20000000-0000-4000-8000-000000000552"}')->>'short_url','https://go.kissmyapps.dev/speaksix-2/josé-núñez','recreated product with same slug receives a new namespace, not old URLs');
set local role service_role;
select throws_ok($q$select * from public.register_short_tracking_click('/speaksix/josé-núñez/instagram-bio','{}')$q$,'P0002',null,'deleted old campaign path cannot redirect to recreated product');
reset role;
select * from finish();
rollback;

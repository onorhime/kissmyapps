begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select ok(
  not has_table_privilege('authenticated', 'public.managed_payment_products', 'INSERT')
  and not has_table_privilege('authenticated', 'public.managed_payment_products', 'UPDATE')
  and not has_table_privilege('anon', 'public.managed_payment_products', 'SELECT'),
  'managed checkout cannot be enabled or inspected directly by a browser'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_admin_product_configuration_before_managed_payments(uuid)', 'EXECUTE'),
  'the preserved configuration projection is internal only'
);

insert into auth.users(id, email, email_confirmed_at)
values('10000000-0000-4000-8000-000000000049', 'managed-catalog@example.invalid', now());
insert into public.admin_users(user_id, role, active)
values('10000000-0000-4000-8000-000000000049', 'owner', true);
insert into public.products(id, slug, name, status)
values('20000000-0000-4000-8000-000000000049', 'managed-catalog', 'Managed catalog', 'active');
insert into public.managed_payment_products(product_id)
values('20000000-0000-4000-8000-000000000049');
select is(
  (select enabled from public.managed_payment_products where product_id='20000000-0000-4000-8000-000000000049'),
  false,
  'managed checkout opt-in defaults to disabled'
);

create temporary table managed_catalog_test (offer_id uuid);
grant select, insert on pg_temp.managed_catalog_test to authenticated, service_role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000049',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000049","role":"authenticated","amr":[{"method":"password","timestamp":1792108800}]}',true);
select is(
  public.get_admin_product_configuration('20000000-0000-4000-8000-000000000049') #>> '{readiness,managed_payment_checkout_enabled}',
  'false',
  'configuration reports the disabled integration without granting browser control'
);
insert into pg_temp.managed_catalog_test
select (public.create_admin_billing_offer(jsonb_build_object(
  'product_id','20000000-0000-4000-8000-000000000049','key','marathon',
  'name','Marathon one-time payment','billing_mode','payment',
  'stripe_price_id','price_ManagedCatalog049','currency','USD','unit_amount_minor',16900,
  'success_url_template','https://marathon.speaksix.com/complete?session_id={CHECKOUT_SESSION_ID}',
  'cancel_url','https://marathon.speaksix.com/checkout'
)) ->> 'id')::uuid;
select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'status','active'))$$,
  'P0001','enable the managed checkout integration before activating a one-time offer',
  'payment offer activation is closed without an enabled managed integration'
);
reset role;
update public.managed_payment_products set enabled=true
where product_id='20000000-0000-4000-8000-000000000049';
set local role authenticated;
select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'status','active'))$$,
  'P0001','verify a Price for the managed checkout account and mode before activation',
  'integration opt-in cannot bypass real Price verification'
);
reset role;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok(public.record_managed_price_verification(jsonb_build_object(
  'billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),
  'product_id','20000000-0000-4000-8000-000000000049','offer_version',1,
  'configured_price_id','price_ManagedCatalog049','account_id','acct_catalogfixture',
  'stripe_price_id','price_ManagedCatalogTest049','livemode',false,
  'currency','USD','unit_amount_minor',16900
)) is not null, 'service attests a matching test-mode one-time Price without a live attestation');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000049","role":"authenticated","amr":[{"method":"password","timestamp":1792108800}]}',true);
select is(
  public.set_admin_billing_offer_status(jsonb_build_object(
    'billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'status','active'
  )) ->> 'status',
  'active','verified payment offer activates for an explicitly enabled managed integration'
);
select is(
  public.get_admin_product_configuration('20000000-0000-4000-8000-000000000049') #>> '{readiness,managed_payment_checkout_enabled}',
  'true','configuration reflects the managed integration capability'
);
select is(
  public.get_admin_product_configuration('20000000-0000-4000-8000-000000000049') #>> '{billing_offers,0,managed_price_verifications,0,livemode}',
  'false','configuration identifies the test-mode attestation without implying live verification'
);
select is(
  public.get_admin_product_configuration('20000000-0000-4000-8000-000000000049') #>> '{readiness,has_active_billing_offer}',
  'false','test-mode managed payment verification does not unlock production partner links'
);
select throws_ok(
  $$select public.update_admin_billing_offer(jsonb_build_object('billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'name','Changed','billing_mode','payment','stripe_price_id','price_ManagedCatalog049','currency','USD','unit_amount_minor',1,'success_url_template','https://marathon.speaksix.com/complete?session_id={CHECKOUT_SESSION_ID}','cancel_url','https://marathon.speaksix.com/checkout'))$$,
  'P0001','only draft billing offers can be edited',
  'activated payment terms remain immutable'
);
select is(public.set_admin_billing_offer_status(jsonb_build_object(
  'billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'status','paused'
)) ->> 'status','paused','managed payment offers can be paused');
reset role;
update public.managed_payment_products set enabled=false
where product_id='20000000-0000-4000-8000-000000000049';
set local role authenticated;
select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select offer_id from pg_temp.managed_catalog_test),'status','active'))$$,
  'P0001','enable the managed checkout integration before activating a one-time offer',
  'paused one-time offers cannot reactivate after managed checkout is disabled'
);
reset role;
select throws_ok(
  $$update public.billing_offers set status='active' where id=(select offer_id from pg_temp.managed_catalog_test)$$,
  'P0001','enable the managed checkout integration before activating a one-time offer',
  'direct active writes also enforce the managed integration opt-in'
);
select * from finish();
rollback;

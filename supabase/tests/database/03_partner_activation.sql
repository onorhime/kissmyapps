begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  invited_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'pending-partner@example.test',
    '$2a$10$temporaryInvitePasswordHashThatIsNotUserChosen000000000000',
    now(), now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'no-membership@example.test',
    '$2a$10$passwordAuthenticatedButNoPartnerMembership0000000000000',
    now(), null, '{}', '{}', now(), now()
  );

insert into public.affiliates (id, public_name, slug, status)
values
  ('30000000-0000-0000-0000-000000000021', 'Pending Partner', 'pending-partner', 'active'),
  ('30000000-0000-0000-0000-000000000022', 'Second Partner', 'second-partner', 'active');

insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values (
  '30000000-0000-0000-0000-000000000021',
  '10000000-0000-0000-0000-000000000021',
  'owner', false, true, null
);

select throws_ok(
  $$insert into public.affiliate_users (affiliate_id, user_id, role, active, activation_pending, activated_at) values ('30000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000022', 'owner', true, false, null)$$,
  '23514', null,
  'an active membership cannot omit its activation timestamp'
);

select throws_ok(
  $$insert into public.affiliate_users (affiliate_id, user_id, role, active, activation_pending, activated_at) values ('30000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000021', 'owner', false, true, null)$$,
  '23505', null,
  'a user cannot hold a second active-or-pending partner membership'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000021', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000021","role":"authenticated","email":"pending-partner@example.test","amr":[{"method":"invite","timestamp":1787868000}]}',
  true
);

select is(
  public.current_partner_activation_status(),
  'pending',
  'an invited membership reports pending activation'
);
select is((select count(*) from public.partner_profile), 0::bigint, 'pending member sees no partner profile');
select is(
  public.current_user_has_affiliate('30000000-0000-0000-0000-000000000021'),
  false,
  'pending member has no workspace authorization'
);
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '42501', 'partner activation requires a password-authenticated session',
  'an invite session cannot activate a membership despite a temporary password hash'
);

reset role;
update auth.users
set encrypted_password = '$2a$10$newUserChosenPasswordHash000000000000000000000000000000'
where id = '10000000-0000-0000-0000-000000000021';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000021', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000021","role":"authenticated","email":"pending-partner@example.test","amr":[{"method":"invite","timestamp":1787868001}]}',
  true
);
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '42501', 'partner activation requires a password-authenticated session',
  'changing the password hash without password authentication remains insufficient'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000021","role":"authenticated","email":"pending-partner@example.test","amr":[{"method":"password","timestamp":1787868002}]}',
  true
);
select is(public.complete_partner_activation(), true, 'password authentication activates the membership');
select is(public.current_partner_activation_status(), 'active', 'activation status becomes active');
select is((select count(*) from public.partner_profile), 1::bigint, 'activated member sees its partner profile');
select is(
  public.current_user_has_affiliate('30000000-0000-0000-0000-000000000021'),
  true,
  'activated member receives workspace authorization'
);
select is(public.complete_partner_activation(), true, 'activation is idempotent after success');

reset role;
select ok(
  (
    select active
      and not activation_pending
      and activated_at is not null
    from public.affiliate_users
    where user_id = '10000000-0000-0000-0000-000000000021'
  ),
  'activation persists the only valid active membership state'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000022', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000022","role":"authenticated","email":"no-membership@example.test","amr":[{"method":"password","timestamp":1787868003}]}',
  true
);
select is(public.current_partner_activation_status(), 'none', 'user without membership reports no partner activation');
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '42501', 'no pending partner invitation',
  'password authentication cannot create or attach a partner membership'
);

select * from finish();
rollback;

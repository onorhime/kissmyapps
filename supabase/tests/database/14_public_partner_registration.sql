begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_table(
  'public', 'platform_legal_acceptances',
  'public registration has durable platform legal acceptance evidence'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.platform_legal_acceptances'::regclass),
  'platform legal acceptances use row-level security'
);
select ok(
  not has_table_privilege('public', 'public.platform_legal_acceptances', 'SELECT')
  and not has_table_privilege('anon', 'public.platform_legal_acceptances', 'SELECT')
  and not has_table_privilege('authenticated', 'public.platform_legal_acceptances', 'SELECT')
  and not has_table_privilege('service_role', 'public.platform_legal_acceptances', 'SELECT'),
  'platform legal acceptance evidence has no API-role read grant'
);
select ok(
  not has_table_privilege('anon', 'public.platform_legal_acceptances', 'INSERT')
  and not has_table_privilege('authenticated', 'public.platform_legal_acceptances', 'INSERT')
  and not has_table_privilege('service_role', 'public.platform_legal_acceptances', 'INSERT')
  and not has_table_privilege('anon', 'public.platform_legal_acceptances', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.platform_legal_acceptances', 'UPDATE')
  and not has_table_privilege('service_role', 'public.platform_legal_acceptances', 'UPDATE')
  and not has_table_privilege('anon', 'public.platform_legal_acceptances', 'DELETE')
  and not has_table_privilege('authenticated', 'public.platform_legal_acceptances', 'DELETE')
  and not has_table_privilege('service_role', 'public.platform_legal_acceptances', 'DELETE'),
  'platform legal acceptance evidence cannot be inserted, changed, or deleted through an API role'
);
select ok(
  has_function_privilege('authenticated', 'public.complete_partner_activation()', 'EXECUTE')
  and not has_function_privilege(
    'authenticated', 'public.public_partner_registration_metadata_valid(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.public_partner_registration_metadata_valid(jsonb)', 'EXECUTE'
  ),
  'only the guarded activation RPC is browser-callable'
);

select ok(
  public.public_partner_registration_metadata_valid(jsonb_build_object(
    'registration_flow', 'public_partner_v1',
    'full_name', repeat('A', 120),
    'terms_version', '2026-07-13',
    'terms_url', 'https://kissmyapps.dev/terms',
    'privacy_version', '2026-07-13',
    'privacy_url', 'https://kissmyapps.dev/privacy',
    'age_confirmed', true
  )),
  'a 120-character public name satisfies the exact registration contract'
);
select ok(
  not public.public_partner_registration_metadata_valid(jsonb_build_object(
    'registration_flow', 'public_partner_v1',
    'full_name', repeat('A', 121),
    'terms_version', '2026-07-13',
    'terms_url', 'https://kissmyapps.dev/terms',
    'privacy_version', '2026-07-13',
    'privacy_url', 'https://kissmyapps.dev/privacy',
    'age_confirmed', true
  )),
  'a public name longer than 120 characters is rejected by the contract'
);

select throws_ok(
  $$
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '10000000-0000-0000-0000-000000000141',
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated', 'invalid-public@example.test',
      '$2a$10$invalidPublicRegistrationPasswordHash000000000000000000',
      now(), '{}',
      '{
        "registration_flow":"public_partner_v1",
        "full_name":"Invalid Public Partner",
        "terms_version":"2026-07-13",
        "terms_url":"https://kissmyapps.dev/terms",
        "privacy_version":"2026-07-13",
        "privacy_url":"https://kissmyapps.dev/privacy",
        "age_confirmed":true,
        "unexpected":"not part of the contract"
      }',
      now(), now()
    )
  $$,
  '22023', 'invalid public partner registration metadata',
  'an explicitly malformed public registration is rejected atomically'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  invited_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000142',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'valid-public@example.test',
    '$2a$10$validPublicRegistrationPasswordHash00000000000000000000',
    now(), null, '{}',
    '{
      "registration_flow":"public_partner_v1",
      "full_name":"Valid Public Partner",
      "terms_version":"2026-07-13",
      "terms_url":"https://kissmyapps.dev/terms",
      "privacy_version":"2026-07-13",
      "privacy_url":"https://kissmyapps.dev/privacy",
      "age_confirmed":true
    }',
    now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000143',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'invited-partner@example.test',
    '$2a$10$invitedPartnerPasswordHash000000000000000000000000000',
    now(), now(), '{}', '{"full_name":"Invited Partner"}', now(), now()
  );

select is(
  (select count(*) from public.profiles where user_id in (
    '10000000-0000-0000-0000-000000000142',
    '10000000-0000-0000-0000-000000000143'
  )),
  2::bigint,
  'normal profile creation remains intact for public and invitation Auth users'
);
select is(
  (
    select count(*)
    from auth.users as auth_user
    left join public.profiles as profile on profile.user_id = auth_user.id
    left join public.affiliate_users as membership on membership.user_id = auth_user.id
    left join public.platform_legal_acceptances as acceptance on acceptance.user_id = auth_user.id
    where auth_user.id = '10000000-0000-0000-0000-000000000141'
       or profile.user_id = '10000000-0000-0000-0000-000000000141'
       or membership.user_id = '10000000-0000-0000-0000-000000000141'
       or acceptance.user_id = '10000000-0000-0000-0000-000000000141'
  ),
  0::bigint,
  'invalid public metadata leaves no Auth, profile, membership, or acceptance row'
);
select ok(
  (
    select affiliate.public_name = 'Valid Public Partner'
      and affiliate.slug = 'partner-100000000000000000000000'
      and affiliate.status = 'invited'
    from public.affiliates as affiliate
    join public.affiliate_users as membership on membership.affiliate_id = affiliate.id
    where membership.user_id = '10000000-0000-0000-0000-000000000142'
  ),
  'exact public metadata provisions an invited non-PII partner workspace'
);
select ok(
  (
    select membership.role = 'owner'
      and not membership.active
      and membership.activation_pending
      and membership.activated_at is null
    from public.affiliate_users as membership
    where membership.user_id = '10000000-0000-0000-0000-000000000142'
  ),
  'public registration provisions only a pending owner membership'
);
select ok(
  (
    select setting.notify_statements
      and setting.notify_payouts
      and setting.notify_verification
      and setting.notify_signatures
      and setting.notify_adjustments
      and setting.notify_inactive_links
    from public.affiliate_settings as setting
    where setting.user_id = '10000000-0000-0000-0000-000000000142'
  ),
  'public registration creates the default notification settings'
);
select ok(
  (
    select acceptance.registration_flow = 'public_partner_v1'
      and acceptance.affiliate_id = membership.affiliate_id
      and acceptance.terms_version = '2026-07-13'
      and acceptance.terms_url = 'https://kissmyapps.dev/terms'
      and acceptance.privacy_version = '2026-07-13'
      and acceptance.privacy_url = 'https://kissmyapps.dev/privacy'
      and acceptance.age_confirmed
      and acceptance.accepted_at is not null
    from public.platform_legal_acceptances as acceptance
    join public.affiliate_users as membership
      on membership.user_id = acceptance.user_id
     and membership.affiliate_id = acceptance.affiliate_id
    where acceptance.user_id = '10000000-0000-0000-0000-000000000142'
  ),
  'exact public terms, privacy, age, and server timestamp evidence is retained'
);

select throws_ok(
  $$update public.platform_legal_acceptances set accepted_at = now() + interval '1 second' where user_id = '10000000-0000-0000-0000-000000000142'$$,
  'P0001', 'platform legal acceptances cannot be updated',
  'platform legal acceptance evidence cannot be rewritten'
);

insert into public.affiliates (id, public_name, slug, status)
values (
  '30000000-0000-0000-0000-000000000143',
  'Invited Partner',
  'invited-partner-contract',
  'active'
);
insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values (
  '30000000-0000-0000-0000-000000000143',
  '10000000-0000-0000-0000-000000000143',
  'owner', false, true, null
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000143', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000143","role":"authenticated","email":"invited-partner@example.test","amr":[{"method":"otp","timestamp":1788138000}]}',
  true
);
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '42501', 'partner activation requires a password-authenticated session',
  'an OTP session cannot activate an invitation without exact public acceptance evidence'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000143","role":"authenticated","email":"invited-partner@example.test","amr":[{"method":"password","timestamp":1788138001}]}',
  true
);
select is(
  public.complete_partner_activation(), true,
  'password authentication still activates an invited membership'
);
select is(
  public.current_partner_activation_status(), 'active',
  'the invited password-authenticated membership becomes active'
);

reset role;
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000144',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'unconfirmed-public@example.test',
    '$2a$10$unconfirmedPublicRegistrationPasswordHash0000000000000',
    null, '{}',
    '{
      "registration_flow":"public_partner_v1",
      "full_name":"Unconfirmed Public Partner",
      "terms_version":"2026-07-13",
      "terms_url":"https://kissmyapps.dev/terms",
      "privacy_version":"2026-07-13",
      "privacy_url":"https://kissmyapps.dev/privacy",
      "age_confirmed":true
    }',
    now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000145',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'passwordless-public@example.test',
    '', now(), '{}',
    '{
      "registration_flow":"public_partner_v1",
      "full_name":"Passwordless Public Partner",
      "terms_version":"2026-07-13",
      "terms_url":"https://kissmyapps.dev/terms",
      "privacy_version":"2026-07-13",
      "privacy_url":"https://kissmyapps.dev/privacy",
      "age_confirmed":true
    }',
    now(), now()
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000144', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000144","role":"authenticated","email":"unconfirmed-public@example.test","amr":[{"method":"otp","timestamp":1788138002}]}',
  true
);
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '55000', 'a verified password credential is required',
  'an OTP session cannot activate an unconfirmed public email'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000145', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000145","role":"authenticated","email":"passwordless-public@example.test","amr":[{"method":"otp","timestamp":1788138002}]}',
  true
);
select throws_ok(
  $$select public.complete_partner_activation()$$,
  '55000', 'a verified password credential is required',
  'an OTP session cannot activate a public registration without a stored password credential'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000142', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000142","role":"authenticated","email":"valid-public@example.test","amr":[{"method":"otp","timestamp":1788138002}]}',
  true
);
select is(
  public.current_partner_activation_status(), 'pending',
  'the exact public registration remains outside the workspace until email confirmation activation'
);
select throws_ok(
  $$select count(*) from public.platform_legal_acceptances$$,
  '42501', null,
  'authenticated browser sessions cannot read raw platform legal acceptance evidence'
);
select throws_ok(
  $$delete from public.platform_legal_acceptances where user_id = '10000000-0000-0000-0000-000000000142'$$,
  '42501', null,
  'authenticated browser sessions cannot delete platform legal acceptance evidence'
);
select is(
  public.complete_partner_activation(), true,
  'the direct OTP confirmation session activates only the exact accepted public registration'
);
select is(
  public.current_partner_activation_status(), 'active',
  'the confirmed public membership becomes active'
);
select is(
  public.complete_partner_activation(), true,
  'repeating public activation is idempotent'
);
select is(
  (select count(*) from public.partner_profile), 1::bigint,
  'the activated public partner receives only its own workspace view'
);

reset role;
select ok(
  (
    select membership.active
      and not membership.activation_pending
      and membership.activated_at is not null
      and affiliate.status = 'active'
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where membership.user_id = '10000000-0000-0000-0000-000000000142'
  ),
  'public email-confirmation activation atomically opens the membership and affiliate workspace'
);

-- Full auth.users deletion is intentionally outside this contract: the existing
-- audit_logs ON DELETE SET NULL path is blocked by the platform's append-only
-- audit trigger and requires a separate, reviewed retention workflow.

select * from finish();
rollback;

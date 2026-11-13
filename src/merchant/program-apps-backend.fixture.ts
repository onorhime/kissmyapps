// What the program functions return for a program that sends people to an app (Phase 7),
// captured from the database suite supabase/tests/database/89_program_app_installs.sql, which
// prints one "capture <name> <json>" line per answer. The program form's readers are tested
// against it (programs.apps.backend.test.ts) and the form itself in programs.apps.test.tsx, so a
// change of shape in the functions shows up as a failing front-end test instead of a broken
// page. The answers from before Phase 7 stay in program-backend.fixture.ts and
// program-rewards-backend.fixture.ts; they stand for an older database.
// To refresh: KMA_DB_TEST_OUTPUT=/tmp/out.txt PG_RUN_AS=postgres node --test
// scripts/merchant-analytics-db.test.mjs, then copy the JSON after each "capture <name>" of
// suite 89 (workspace_program_reward_events.listed comes from suite 84 on the same database).
export const programAppsBackendFixture: Record<string, unknown> = {
  'workspace_program_app_links.listed': {
    links: [
      {
        id: '7082151a-de79-4141-99b5-0470bb89e93e',
        ios: false,
        url: 'https://fluent.go.kissmyapps.dev/get-app',
        name: 'Get the app',
        android: true,
        project_id: '0be808cd-1411-4791-b8f2-ce3038d2c865',
        project_name: 'Fluent',
      },
    ],
  },
  'workspace_program_get.app_program': {
    program: {
      id: 'd845b5a5-6a3c-4ebe-a45f-ba6e522cbb92',
      name: 'Fluent',
      slug: 'fluent',
      status: 'draft',
      rewards: [
        {
          key: 'app_installed',
          label: 'App installed',
          amount_minor: 150,
        },
        {
          key: 'signup_completed',
          label: 'Account created',
          amount_minor: 200,
        },
      ],
      tagline: 'Speak a new language in a month.',
      app_link: {
        id: '7082151a-de79-4141-99b5-0470bb89e93e',
        url: 'https://fluent.go.kissmyapps.dev/get-app',
        name: 'Get the app',
      },
      category: 'education',
      currency: 'USD',
      revision: 1,
      earn_from: 'events',
      hold_days: 14,
      logo_path: null,
      updated_at: '2026-11-13T20:25:29.138964+00:00',
      extra_terms: null,
      landing_url: 'https://fluent.go.kissmyapps.dev/get-app',
      review_note: null,
      pause_reason: null,
      submitted_at: null,
      approval_mode: 'automatic',
      agreement_read: false,
      commission_type: null,
      commission_months: null,
      first_published_at: null,
      live_terms_version: null,
      marketplace_listed: true,
      commission_duration: null,
      commission_rate_bps: null,
      reward_budget_minor: 10000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
      has_unpublished_changes: false,
    },
    checklist: {
      details: true,
      commission: true,
      landing_page: true,
      agreement_read: false,
      stripe_connected: true,
    },
    brand_name: 'Fluent Ltd',
    can_manage: true,
    can_submit: false,
    events_available: true,
    stripe_connected: true,
    app_links_available: true,
  },
  'workspace_program_reward_events.with_app_events': {
    events: [
      {
        name: 'signup_completed',
        last_seen: '2026-11-13T20:25:29.149+00:00',
        first_seen: '2026-11-13T20:25:29.149+00:00',
        description: null,
        suggested_label: null,
      },
      {
        name: 'app_opened',
        last_seen: '2026-11-13T20:25:29.139+00:00',
        first_seen: '2026-11-13T20:25:29.139+00:00',
        description: null,
        suggested_label: 'App opened',
      },
      {
        name: 'app_installed',
        last_seen: '2026-11-13T20:25:29.129+00:00',
        first_seen: '2026-11-13T20:25:29.129+00:00',
        description: null,
        suggested_label: 'App installed',
      },
      {
        name: 'session_started',
        last_seen: '2026-11-13T20:25:29.119+00:00',
        first_seen: '2026-11-13T20:25:29.119+00:00',
        description: null,
        suggested_label: null,
      },
    ],
  },
  'workspace_program_reward_events.listed': {
    events: [
      {
        name: 'trial_started',
        last_seen: '2026-11-13T09:00:00+00:00',
        first_seen: '2026-10-05T10:00:00+00:00',
        description: null,
        suggested_label: null,
      },
      {
        name: 'signup_completed',
        last_seen: '2026-11-13T07:15:00+00:00',
        first_seen: '2026-09-20T08:00:00+00:00',
        description: 'An account was made',
        suggested_label: null,
      },
      {
        name: 'lesson_finished',
        last_seen: '2026-11-01T10:00:00+00:00',
        first_seen: '2026-10-01T10:00:00+00:00',
        description: 'A lesson was finished',
        suggested_label: null,
      },
    ],
  },
}

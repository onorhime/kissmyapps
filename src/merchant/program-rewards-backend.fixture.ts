// What the program functions return for a program that can pay for events (Phase 6),
// captured from the database suite supabase/tests/database/84_program_reward_terms.sql, which
// prints one "capture <name> <json>" line per answer. The program form's readers are tested
// against it (programs.rewards.backend.test.ts), so a change of shape in the functions shows up
// as a failing front-end test instead of a broken page. The answers from before Phase 6 stay in
// program-backend.fixture.ts.
// To refresh: KMA_DB_TEST_OUTPUT=/tmp/out.txt PG_RUN_AS=postgres node --test
// scripts/merchant-analytics-db.test.mjs, then copy the JSON after each "capture <name>" of
// suite 84.
export const programRewardsBackendFixture: Record<string, unknown> = {
  'workspace_program_get.events_draft': {
    program: {
      id: 'e98f3fa1-63b8-4599-a1b8-0520b98ddaf1',
      name: 'Fluent',
      slug: 'fluent',
      status: 'draft',
      rewards: [
        {
          key: 'signup_completed',
          label: 'Account created',
          amount_minor: 200,
        },
        {
          key: 'trial_started',
          label: 'Trial started',
          amount_minor: 500,
        },
      ],
      tagline: 'Speak a new language in ten minutes a day.',
      category: 'education',
      currency: 'USD',
      revision: 15,
      earn_from: 'events',
      hold_days: 30,
      logo_path: null,
      updated_at: '2026-11-13T18:45:26.29677+00:00',
      extra_terms: null,
      landing_url: 'https://fluent.speaksix.com/start',
      review_note: null,
      pause_reason: null,
      submitted_at: null,
      approval_mode: 'manual',
      agreement_read: false,
      commission_type: 'percent',
      commission_months: null,
      first_published_at: null,
      live_terms_version: null,
      marketplace_listed: true,
      commission_duration: 'lifetime',
      commission_rate_bps: 3000,
      reward_budget_minor: 50000,
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
    brand_name: 'Fluent Labs',
    can_manage: true,
    can_submit: false,
    events_available: true,
    stripe_connected: true,
  },
  'workspace_program_get.events_live': {
    program: {
      id: 'e98f3fa1-63b8-4599-a1b8-0520b98ddaf1',
      name: 'Fluent',
      slug: 'fluent',
      status: 'live',
      rewards: [
        {
          key: 'signup_completed',
          label: 'Account created',
          amount_minor: 200,
        },
        {
          key: 'trial_started',
          label: 'Trial started',
          amount_minor: 500,
        },
      ],
      tagline: 'Speak a new language in ten minutes a day.',
      category: 'education',
      currency: 'USD',
      revision: 18,
      earn_from: 'events',
      hold_days: 30,
      logo_path: null,
      updated_at: '2026-11-13T18:45:26.405069+00:00',
      extra_terms: null,
      landing_url: 'https://fluent.speaksix.com/start',
      review_note: null,
      pause_reason: null,
      submitted_at: '2026-11-13T18:45:26.372675+00:00',
      approval_mode: 'manual',
      agreement_read: true,
      commission_type: 'percent',
      commission_months: null,
      first_published_at: '2026-11-13T18:45:26.405069+00:00',
      live_terms_version: 1,
      marketplace_listed: true,
      commission_duration: 'lifetime',
      commission_rate_bps: 3000,
      reward_budget_minor: 50000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
      has_unpublished_changes: false,
    },
    checklist: {
      details: true,
      commission: true,
      landing_page: true,
      agreement_read: true,
      stripe_connected: true,
    },
    brand_name: 'Fluent Labs',
    can_manage: true,
    can_submit: false,
    events_available: true,
    stripe_connected: true,
  },
  'workspace_program_get.both_live': {
    program: {
      id: 'ac6f89d3-1031-4dfb-9644-4483ecbb0384',
      name: 'Rival Reader',
      slug: 'rival-reader',
      status: 'live',
      rewards: [
        {
          key: 'chapter_read',
          label: 'First chapter read',
          amount_minor: 150,
        },
      ],
      tagline: 'Stories worth an evening.',
      category: 'entertainment',
      currency: 'USD',
      revision: 4,
      earn_from: 'both',
      hold_days: 14,
      logo_path: null,
      updated_at: '2026-11-13T18:45:26.551534+00:00',
      extra_terms: null,
      landing_url: 'https://rivalreader.co/',
      review_note: null,
      pause_reason: null,
      submitted_at: '2026-11-13T18:45:26.545103+00:00',
      approval_mode: 'automatic',
      agreement_read: true,
      commission_type: 'percent',
      commission_months: 6,
      first_published_at: '2026-11-13T18:45:26.551534+00:00',
      live_terms_version: 1,
      marketplace_listed: true,
      commission_duration: 'months',
      commission_rate_bps: 2000,
      reward_budget_minor: 30000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
      has_unpublished_changes: false,
    },
    checklist: {
      details: true,
      commission: true,
      landing_page: true,
      agreement_read: true,
      stripe_connected: true,
    },
    brand_name: 'Rival Media',
    can_manage: true,
    can_submit: false,
    events_available: true,
    stripe_connected: true,
  },
  'workspace_program_get.sales_live': {
    program: {
      id: '990b95c0-fafb-487b-9afb-2801786b94e7',
      name: 'Quiet Club',
      slug: 'quiet-club',
      status: 'live',
      rewards: [
        {
          key: 'signup_completed',
          label: 'Account created',
          amount_minor: 200,
        },
      ],
      tagline: 'A calmer phone.',
      category: 'lifestyle',
      currency: 'USD',
      revision: 6,
      earn_from: 'sales',
      hold_days: 14,
      logo_path: null,
      updated_at: '2026-11-13T18:45:26.179536+00:00',
      extra_terms: null,
      landing_url: 'https://quietclub.io/join',
      review_note: null,
      pause_reason: null,
      submitted_at: '2026-11-13T18:45:26.140046+00:00',
      approval_mode: 'automatic',
      agreement_read: true,
      commission_type: 'percent',
      commission_months: null,
      first_published_at: '2026-11-13T18:45:26.146748+00:00',
      live_terms_version: 2,
      marketplace_listed: true,
      commission_duration: 'lifetime',
      commission_rate_bps: 2000,
      reward_budget_minor: 50000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
      has_unpublished_changes: false,
    },
    checklist: {
      details: true,
      commission: true,
      landing_page: true,
      agreement_read: true,
      stripe_connected: true,
    },
    brand_name: 'Quiet Club',
    can_manage: true,
    can_submit: false,
    events_available: true,
    stripe_connected: true,
  },
  'workspace_program_reward_events.listed': {
    events: [
      {
        name: 'trial_started',
        last_seen: '2026-11-13T09:00:00+00:00',
        first_seen: '2026-10-05T10:00:00+00:00',
        description: null,
      },
      {
        name: 'signup_completed',
        last_seen: '2026-11-13T07:15:00+00:00',
        first_seen: '2026-09-20T08:00:00+00:00',
        description: 'An account was made',
      },
      {
        name: 'lesson_finished',
        last_seen: '2026-11-01T10:00:00+00:00',
        first_seen: '2026-10-01T10:00:00+00:00',
        description: 'A lesson was finished',
      },
    ],
  },
  'workspace_program_reward_events.none': {
    events: [],
  },
  'workspace_program_agreement.events': {
    sha256: 'df07832da2ab7c6ee3ac39430501b572315c06d56ebd18981a0023f419e2d7a1',
    complete: true,
    agreement: {
      title: 'Fluent Affiliate Agreement',
      summary: [
        {
          label: 'Rewards',
          value: '$2.00 per Account created, $5.00 per Trial started',
        },
        {
          label: 'Attribution window',
          value: '30 days',
        },
        {
          label: 'Hold before payout',
          value: '30 days',
        },
        {
          label: 'Minimum payout',
          value: '$20.00',
        },
      ],
      sections: [
        {
          heading: '1. Who this agreement is between',
          paragraphs: [
            'This agreement is between you, the creator, and Fluent Labs, the business behind Fluent. KissMyApps is the platform the program runs on. It tracks what people do after they open your link and pays your rewards on behalf of Fluent Labs.',
            'You sign this agreement by accepting it on KissMyApps. Fluent Labs agreed to these terms when it published them, so nobody needs to countersign.',
          ],
        },
        {
          heading: '2. What you promote',
          paragraphs: [
            'You promote Fluent. KissMyApps gives you your own link, and people who click it land on https://fluent.speaksix.com/start.',
            'Fluent Labs approves each creator. You can start once you have been approved.',
          ],
        },
        {
          heading: '3. Rewards',
          paragraphs: [
            'You earn a reward when a person who opened your link does one of the things below. Each reward is a fixed amount.',
            'Account created: $2.00.',
            'Trial started: $5.00.',
            'Each reward is earned once per person. If the same person does the same thing again, you earn nothing more for it.',
            'This program pays these rewards only. Sales made through your link earn no commission.',
          ],
        },
        {
          heading: '4. How a reward is credited to you',
          paragraphs: [
            'A reward is credited to you when a person opens your link and, within 30 days of that click, does what the reward is for.',
            "If that person opened more than one creator's link in that time, the reward goes to the last link they opened.",
            'Only actions that KissMyApps has tracked count. Your own actions earn nothing: you cannot earn a reward by signing up to Fluent or using it yourself.',
          ],
        },
        {
          heading: '5. Limits on rewards',
          paragraphs: [
            'Fluent Labs sets a budget for rewards for each calendar month and can change it at any time. KissMyApps sets a limit on what one creator can earn in rewards in one day.',
            'Rewards stop when the monthly budget or your daily limit is reached, and start again with the next month or the next day. Actions in between earn no reward.',
          ],
        },
        {
          heading: '6. Hold and rejected rewards',
          paragraphs: [
            'A reward is held for 30 days after it is earned before it can be paid out.',
            'During the hold Fluent Labs may reject a reward that is fake, a duplicate or your own action. A rejected reward is cancelled and pays nothing.',
          ],
        },
        {
          heading: '7. Payouts',
          paragraphs: [
            'KissMyApps pays your rewards on behalf of Fluent Labs, to the payout account you connect on KissMyApps.',
            'Rewards become payable once they have passed the hold. They are paid when what is payable to you reaches $20.00.',
            'KissMyApps pays out only from money Fluent Labs has provided for rewards. Until Fluent Labs provides it, what you have earned is owed to you by Fluent Labs, not by KissMyApps.',
          ],
        },
        {
          heading: '8. How you may promote',
          paragraphs: [
            'Be honest. Only say things about Fluent that are true.',
            'Tell your audience clearly that you earn money when they use your link.',
            'Do not send spam. Do not bid on the Fluent or Fluent Labs name in paid search ads. Do not use or buy through your own link. Do not send fake, automated or paid-for clicks, sign-ups or other actions.',
            'Actions that break these rules earn no reward.',
          ],
        },
        {
          heading: '9. The Fluent name and logo',
          paragraphs: [
            'While this agreement is in force you may use the Fluent name and logo, unchanged, to promote it. Do not present yourself as Fluent Labs or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
          ],
        },
        {
          heading: '10. Changes to these terms',
          paragraphs: [
            'Fluent Labs can change these terms by publishing a new version. KissMyApps will ask you to accept it.',
            'What you have already earned keeps the terms it was earned under.',
          ],
        },
        {
          heading: '11. Ending this agreement',
          paragraphs: [
            'You or Fluent Labs can end this agreement at any time.',
            'What you earned before it ended is still paid once it has passed the hold.',
            'Actions that happen after it ends earn no reward.',
          ],
        },
        {
          heading: '12. Independent relationship',
          paragraphs: [
            'You promote Fluent as an independent creator. You are not an employee, agent or partner of Fluent Labs or of KissMyApps, and you cannot make commitments on their behalf.',
          ],
        },
      ],
      brand_name: 'Fluent Labs',
      extra_terms: null,
      program_name: 'Fluent',
    },
  },
  'workspace_program_agreement.both': {
    sha256: '5169b00a8e58b19239bb3484dcf7b28a4d8c08108139e32d2154110ddaecf2b3',
    complete: true,
    agreement: {
      title: 'Rival Reader Affiliate Agreement',
      summary: [
        {
          label: 'Commission',
          value: '20% of every payment for 6 months',
        },
        {
          label: 'Rewards',
          value: '$1.50 per First chapter read',
        },
        {
          label: 'Attribution window',
          value: '30 days',
        },
        {
          label: 'Hold before payout',
          value: '14 days',
        },
        {
          label: 'Minimum payout',
          value: '$20.00',
        },
      ],
      sections: [
        {
          heading: '1. Who this agreement is between',
          paragraphs: [
            'This agreement is between you, the creator, and Rival Media, the business behind Rival Reader. KissMyApps is the platform the program runs on. It tracks what people do after they open your link and pays your commission and rewards on behalf of Rival Media.',
            'You sign this agreement by accepting it on KissMyApps. Rival Media agreed to these terms when it published them, so nobody needs to countersign.',
          ],
        },
        {
          heading: '2. What you promote',
          paragraphs: [
            'You promote Rival Reader. KissMyApps gives you your own link, and people who click it land on https://rivalreader.co/.',
            'You can start as soon as you accept this agreement.',
          ],
        },
        {
          heading: '3. Commission',
          paragraphs: [
            "You earn 20% of every payment credited to you, for 6 months counted from the customer's first payment. Payments after that do not earn commission.",
            'Section 4 explains which payments are credited to you.',
          ],
        },
        {
          heading: '4. How a sale is credited to you',
          paragraphs: [
            'A sale is credited to you when a customer clicks your link and pays Rival Media within 30 days of that click.',
            "If the customer clicked more than one creator's link in that time, the sale goes to the last link they clicked before paying.",
            'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
            'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.',
          ],
        },
        {
          heading: '5. Rewards',
          paragraphs: [
            'You also earn a reward when a person who opened your link does one of the things below, whether or not they buy. Each reward is a fixed amount.',
            'First chapter read: $1.50.',
            'Each reward is earned once per person. If the same person does the same thing again, you earn nothing more for it.',
          ],
        },
        {
          heading: '6. How a reward is credited to you',
          paragraphs: [
            'A reward is credited to you when a person opens your link and, within 30 days of that click, does what the reward is for.',
            "If that person opened more than one creator's link in that time, the reward goes to the last link they opened.",
            'Only actions that KissMyApps has tracked count. Your own actions earn nothing: you cannot earn a reward by signing up to Rival Reader or using it yourself.',
          ],
        },
        {
          heading: '7. Limits on rewards',
          paragraphs: [
            'Rival Media sets a budget for rewards for each calendar month and can change it at any time. KissMyApps sets a limit on what one creator can earn in rewards in one day.',
            'Rewards stop when the monthly budget or your daily limit is reached, and start again with the next month or the next day. Actions in between earn no reward.',
          ],
        },
        {
          heading: '8. Hold, refunds and chargebacks',
          paragraphs: [
            'Commission is held for 14 days after each payment before it can be paid out. This leaves time for refunds and disputes.',
            'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
            'If that commission was already paid to you, the amount is taken out of what you earn later.',
          ],
        },
        {
          heading: '9. Hold and rejected rewards',
          paragraphs: [
            'A reward is held for 14 days after it is earned before it can be paid out.',
            'During the hold Rival Media may reject a reward that is fake, a duplicate or your own action. A rejected reward is cancelled and pays nothing.',
          ],
        },
        {
          heading: '10. Payouts',
          paragraphs: [
            'KissMyApps pays your commission and rewards on behalf of Rival Media, to the payout account you connect on KissMyApps.',
            'Commission and rewards become payable once they have passed the hold. They are paid when what is payable to you reaches $20.00.',
            'KissMyApps pays out only from money Rival Media has provided for commission and rewards. Until Rival Media provides it, what you have earned is owed to you by Rival Media, not by KissMyApps.',
          ],
        },
        {
          heading: '11. How you may promote',
          paragraphs: [
            'Be honest. Only say things about Rival Reader that are true.',
            'Tell your audience clearly that you earn money when they use your link.',
            'Do not send spam. Do not bid on the Rival Reader or Rival Media name in paid search ads. Do not use or buy through your own link. Do not send fake, automated or paid-for clicks, sign-ups or other actions.',
            'Sales and actions that break these rules earn nothing.',
          ],
        },
        {
          heading: '12. The Rival Reader name and logo',
          paragraphs: [
            'While this agreement is in force you may use the Rival Reader name and logo, unchanged, to promote it. Do not present yourself as Rival Media or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
          ],
        },
        {
          heading: '13. Changes to these terms',
          paragraphs: [
            'Rival Media can change these terms by publishing a new version. KissMyApps will ask you to accept it.',
            'What you have already earned keeps the terms it was earned under.',
          ],
        },
        {
          heading: '14. Ending this agreement',
          paragraphs: [
            'You or Rival Media can end this agreement at any time.',
            'What you earned before it ended is still paid once it has passed the hold.',
            'Payments and actions that happen after it ends earn nothing.',
          ],
        },
        {
          heading: '15. Independent relationship',
          paragraphs: [
            'You promote Rival Reader as an independent creator. You are not an employee, agent or partner of Rival Media or of KissMyApps, and you cannot make commitments on their behalf.',
          ],
        },
      ],
      brand_name: 'Rival Media',
      extra_terms: null,
      program_name: 'Rival Reader',
    },
  },
}

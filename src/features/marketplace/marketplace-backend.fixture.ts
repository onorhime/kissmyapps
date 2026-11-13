/**
 * What the marketplace functions really return for programs that pay per event, captured from
 * supabase/tests/database/84_program_reward_terms.sql ("capture" lines): marketplace_programs.mixed,
 * and the program of partner_program_detail.events and .both, which is the same
 * kma_internal.program_detail that marketplace_program and the public function answer with.
 * Answers from before programs could pay per event are in src/merchant/creator-backend.fixture.ts.
 */
export const marketplaceBackendFixture = {
  marketplace_programs_mixed: {
    programs: [
      {
        name: 'Rival Reader',
        slug: 'rival-reader',
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
        earn_from: 'both',
        hold_days: 14,
        logo_path: null,
        brand_name: 'Rival Media',
        approval_mode: 'automatic',
        terms_version: 1,
        commission_type: 'percent',
        commission_months: 6,
        commission_duration: 'months',
        commission_rate_bps: 2000,
        minimum_payout_minor: 2000,
        commission_fixed_minor: null,
        attribution_window_days: 30,
      },
      {
        name: 'Fluent',
        slug: 'fluent',
        rewards: [
          {
            key: 'account_created',
            label: 'Account created',
            amount_minor: 300,
          },
          {
            key: 'trial_started',
            label: 'Trial started',
            amount_minor: 500,
          },
          {
            key: 'lesson_finished',
            label: 'First lesson',
            amount_minor: 100,
          },
        ],
        tagline: 'Speak a new language in ten minutes a day.',
        category: 'education',
        currency: 'USD',
        earn_from: 'events',
        hold_days: 30,
        logo_path: null,
        brand_name: 'Fluent Labs',
        approval_mode: 'manual',
        terms_version: 3,
        commission_type: null,
        commission_months: null,
        commission_duration: null,
        commission_rate_bps: null,
        minimum_payout_minor: 2000,
        commission_fixed_minor: null,
        attribution_window_days: 30,
      },
      {
        name: 'Quiet Club',
        slug: 'quiet-club',
        rewards: [],
        tagline: 'A calmer phone.',
        category: 'lifestyle',
        currency: 'USD',
        earn_from: 'sales',
        hold_days: 14,
        logo_path: null,
        brand_name: 'Quiet Club',
        approval_mode: 'automatic',
        terms_version: 2,
        commission_type: 'percent',
        commission_months: null,
        commission_duration: 'lifetime',
        commission_rate_bps: 2000,
        minimum_payout_minor: 2000,
        commission_fixed_minor: null,
        attribution_window_days: 30,
      },
    ],
  },
  marketplace_program_events: {
    program: {
      id: 'e98f3fa1-63b8-4599-a1b8-0520b98ddaf1',
      name: 'Fluent',
      slug: 'fluent',
      status: 'live',
      rewards: [
        {
          key: 'signup_completed',
          label: 'Account created',
          amount_minor: 300,
        },
        {
          key: 'trial_started',
          label: 'Trial started',
          amount_minor: 500,
        },
        {
          key: 'lesson_finished',
          label: 'First lesson',
          amount_minor: 100,
        },
      ],
      tagline: 'Speak a new language in ten minutes a day.',
      category: 'education',
      currency: 'USD',
      agreement: {
        title: 'Fluent Affiliate Agreement',
        summary: [
          {
            label: 'Rewards',
            value: '$3.00 per Account created, $5.00 per Trial started, $1.00 per First lesson',
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
              'Account created: $3.00.',
              'Trial started: $5.00.',
              'First lesson: $1.00.',
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
      earn_from: 'events',
      hold_days: 30,
      logo_path: null,
      brand_name: 'Fluent Labs',
      landing_url: 'https://fluent.speaksix.com/start',
      approval_mode: 'manual',
      terms_version: 2,
      commission_type: null,
      agreement_sha256: 'aa84d9a27cc0e9f0bdc580d05497062e7e9bd98f7eb71e6bbefa4e849cecb209',
      commission_months: null,
      commission_duration: null,
      commission_rate_bps: null,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
    },
  },
  marketplace_program_both: {
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
      earn_from: 'both',
      hold_days: 14,
      logo_path: null,
      brand_name: 'Rival Media',
      landing_url: 'https://rivalreader.co/',
      approval_mode: 'automatic',
      terms_version: 1,
      commission_type: 'percent',
      agreement_sha256: '5169b00a8e58b19239bb3484dcf7b28a4d8c08108139e32d2154110ddaecf2b3',
      commission_months: 6,
      commission_duration: 'months',
      commission_rate_bps: 2000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
    },
  },
}

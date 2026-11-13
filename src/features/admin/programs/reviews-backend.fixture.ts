/**
 * What list_admin_program_reviews really returns once programs can pay per event, captured from
 * supabase/tests/database/84_program_reward_terms.sql (its "capture list_admin_program_reviews.events"
 * line): an events listing waiting for review, and a live sales program. A review row carries the
 * stored program, so the events listing still has the commission the merchant once typed, and the
 * sales program still has rewards and a budget it does not use: what it pays is read by earn_from.
 */
export const programReviewsBackendFixture = {
  programs: [
    {
      id: 'e98f3fa1-63b8-4599-a1b8-0520b98ddaf1',
      name: 'Fluent',
      slug: 'fluent',
      status: 'in_review',
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
      revision: 17,
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
      earn_from: 'events',
      hold_days: 30,
      logo_path: null,
      brand_name: 'Fluent Labs',
      updated_at: '2026-11-13T18:45:26.372675+00:00',
      extra_terms: null,
      landing_url: 'https://fluent.speaksix.com/start',
      review_note: null,
      reviewed_at: null,
      pause_reason: null,
      submitted_at: '2026-11-13T18:45:26.372675+00:00',
      workspace_id: '72ac554d-f733-4df8-b4e5-fae3f5752724',
      approval_mode: 'manual',
      agreement_read: true,
      stripe_country: 'GB',
      workspace_name: 'Fluent',
      commission_type: 'percent',
      commission_months: null,
      stripe_account_id: 'acct_Fluent',
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
    {
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
      agreement: {
        title: 'Quiet Club Affiliate Agreement',
        summary: [
          {
            label: 'Commission',
            value: '20% of every payment',
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
              'This agreement is between you, the creator, and Quiet Club. KissMyApps is the platform the program runs on. It tracks sales and pays commission on behalf of Quiet Club.',
              'You sign this agreement by accepting it on KissMyApps. Quiet Club agreed to these terms when it published them, so nobody needs to countersign.',
            ],
          },
          {
            heading: '2. What you promote',
            paragraphs: [
              'You promote Quiet Club. KissMyApps gives you your own link, and people who click it land on https://quietclub.io/join.',
              'You can start as soon as you accept this agreement.',
            ],
          },
          {
            heading: '3. Commission',
            paragraphs: [
              'You earn 20% of every payment credited to you, with no time limit.',
              'Section 4 explains which payments are credited to you.',
            ],
          },
          {
            heading: '4. How a sale is credited to you',
            paragraphs: [
              'A sale is credited to you when a customer clicks your link and pays Quiet Club within 30 days of that click.',
              "If the customer clicked more than one creator's link in that time, the sale goes to the last link they clicked before paying.",
              'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
              'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.',
            ],
          },
          {
            heading: '5. Hold, refunds and chargebacks',
            paragraphs: [
              'Commission is held for 14 days after each payment before it can be paid out. This leaves time for refunds and disputes.',
              'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
              'If that commission was already paid to you, the amount is taken out of your later commission.',
            ],
          },
          {
            heading: '6. Payouts',
            paragraphs: [
              'KissMyApps pays your commission on behalf of Quiet Club, to the payout account you connect on KissMyApps.',
              'Commission becomes payable once it has passed the hold. It is paid when your payable commission reaches $20.00.',
              'KissMyApps pays out only from money Quiet Club has provided for commission. Until Quiet Club provides it, the commission is owed to you by Quiet Club, not by KissMyApps.',
            ],
          },
          {
            heading: '7. How you may promote',
            paragraphs: [
              'Be honest. Only say things about Quiet Club that are true.',
              'Tell your audience clearly that you earn commission when they buy through your link.',
              'Do not send spam. Do not bid on the Quiet Club name in paid search ads. Do not buy through your own link. Do not send fake, automated or paid-for clicks or sign-ups.',
              'Sales that break these rules earn no commission.',
            ],
          },
          {
            heading: '8. The Quiet Club name and logo',
            paragraphs: [
              'While this agreement is in force you may use the Quiet Club name and logo, unchanged, to promote it. Do not present yourself as Quiet Club or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
            ],
          },
          {
            heading: '9. Changes to these terms',
            paragraphs: [
              'Quiet Club can change these terms by publishing a new version. KissMyApps will ask you to accept it.',
              'Commission you have already earned keeps the terms it was earned under.',
            ],
          },
          {
            heading: '10. Ending this agreement',
            paragraphs: [
              'You or Quiet Club can end this agreement at any time.',
              'Commission you earned before it ended is still paid once it has passed the hold.',
              'Payments made after it ends do not earn commission.',
            ],
          },
          {
            heading: '11. Independent relationship',
            paragraphs: [
              'You promote Quiet Club as an independent creator. You are not an employee, agent or partner of Quiet Club or of KissMyApps, and you cannot make commitments on their behalf.',
            ],
          },
        ],
        brand_name: 'Quiet Club',
        extra_terms: null,
        program_name: 'Quiet Club',
      },
      earn_from: 'sales',
      hold_days: 14,
      logo_path: null,
      brand_name: 'Quiet Club',
      updated_at: '2026-11-13T18:45:26.179536+00:00',
      extra_terms: null,
      landing_url: 'https://quietclub.io/join',
      review_note: null,
      reviewed_at: '2026-11-13T18:45:26.146748+00:00',
      pause_reason: null,
      submitted_at: '2026-11-13T18:45:26.140046+00:00',
      workspace_id: 'bd370c31-9adc-4224-a110-ef82a717bacd',
      approval_mode: 'automatic',
      agreement_read: true,
      stripe_country: 'GB',
      workspace_name: 'Quiet',
      commission_type: 'percent',
      commission_months: null,
      stripe_account_id: 'acct_Quiet',
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
  ],
}

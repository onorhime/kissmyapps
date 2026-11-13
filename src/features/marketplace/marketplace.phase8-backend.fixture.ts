// What the Phase 8 database functions really return, captured from the database suite
// supabase/tests/database/90_program_checkout_promo.sql (one "capture" line per call). The readers of this
// folder are tested against it in *.phase8.backend.test.ts, so a change of shape in the
// functions shows up as a failing front-end test instead of a broken page. Do not edit by
// hand: capture again instead.

export const marketplacePhase8BackendFixture: Record<string, unknown> = {
  marketplace_program_with_checkout: {
    program: {
      id: 'aecc22db-f13e-4966-9a7d-2c5040a6d418',
      name: 'Fluent',
      slug: 'fluent',
      status: 'live',
      rewards: [],
      tagline: 'Speak a new language in a month.',
      category: 'education',
      checkout: {
        name: 'Fluent Pro',
        interval: 'month',
        amount_minor: 999,
      },
      currency: 'USD',
      agreement: {
        title: 'Fluent Affiliate Agreement',
        summary: [
          {
            label: 'Commission',
            value: '30% of every payment',
          },
          {
            label: 'Product',
            value: 'Fluent Pro, $9.99 a month',
          },
          {
            label: 'Buyer discount',
            value: '10% off with your code',
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
              'This agreement is between you, the creator, and Fluent Ltd, the business behind Fluent. KissMyApps is the platform the program runs on. It tracks sales and pays commission on behalf of Fluent Ltd.',
              'You sign this agreement by accepting it on KissMyApps. Fluent Ltd agreed to these terms when it published them, so nobody needs to countersign.',
            ],
          },
          {
            heading: '2. What you promote',
            paragraphs: [
              'You promote Fluent. KissMyApps gives you your own link, and people who click it go to a checkout where they can buy Fluent Pro for $9.99 a month.',
              'You can start as soon as you accept this agreement.',
            ],
          },
          {
            heading: '3. Commission',
            paragraphs: [
              'You earn 30% of every payment credited to you, with no time limit.',
              'Section 4 explains which payments are credited to you.',
            ],
          },
          {
            heading: '4. How a sale is credited to you',
            paragraphs: [
              'A sale is credited to you when a customer clicks your link and pays Fluent Ltd within 30 days of that click.',
              "If the customer clicked more than one creator's link in that time, the sale goes to the last link they clicked before paying.",
              'KissMyApps also gives you your own promo code, which gives buyers 10% off and is applied by itself on the checkout your link opens.',
              "A sale paid with your promo code is credited to you, even if the customer did not click your link or clicked another creator's link. Commission is worked out on what the customer paid after the discount.",
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
              'KissMyApps pays your commission on behalf of Fluent Ltd, to the payout account you connect on KissMyApps.',
              'Commission becomes payable once it has passed the hold. It is paid when your payable commission reaches $20.00.',
              'KissMyApps pays out only from money Fluent Ltd has provided for commission. Until Fluent Ltd provides it, the commission is owed to you by Fluent Ltd, not by KissMyApps.',
            ],
          },
          {
            heading: '7. How you may promote',
            paragraphs: [
              'Be honest. Only say things about Fluent that are true.',
              'Tell your audience clearly that you earn commission when they buy through your link.',
              'Do not send spam. Do not bid on the Fluent or Fluent Ltd name in paid search ads. Do not buy through your own link. Do not send fake, automated or paid-for clicks or sign-ups.',
              'Sales that break these rules earn no commission.',
            ],
          },
          {
            heading: '8. The Fluent name and logo',
            paragraphs: [
              'While this agreement is in force you may use the Fluent name and logo, unchanged, to promote it. Do not present yourself as Fluent Ltd or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
            ],
          },
          {
            heading: '9. Changes to these terms',
            paragraphs: [
              'Fluent Ltd can change these terms by publishing a new version. KissMyApps will ask you to accept it.',
              'Commission you have already earned keeps the terms it was earned under.',
            ],
          },
          {
            heading: '10. Ending this agreement',
            paragraphs: [
              'You or Fluent Ltd can end this agreement at any time.',
              'Commission you earned before it ended is still paid once it has passed the hold.',
              'Payments made after it ends do not earn commission.',
            ],
          },
          {
            heading: '11. Independent relationship',
            paragraphs: [
              'You promote Fluent as an independent creator. You are not an employee, agent or partner of Fluent Ltd or of KissMyApps, and you cannot make commitments on their behalf.',
            ],
          },
        ],
        brand_name: 'Fluent Ltd',
        extra_terms: null,
        program_name: 'Fluent',
      },
      earn_from: 'sales',
      hold_days: 14,
      logo_path: null,
      brand_name: 'Fluent Ltd',
      landing_url: 'https://kissmyapps.dev/checkout/fluent',
      payment_mode: 'kma_checkout',
      approval_mode: 'automatic',
      terms_version: 1,
      commission_type: 'percent',
      agreement_sha256: '30e01e0eb295ad2c965217dedc1cce0924958806496780360906f34cd982decd',
      commission_months: null,
      buyer_discount_bps: 1000,
      commission_duration: 'lifetime',
      commission_rate_bps: 3000,
      minimum_payout_minor: 2000,
      commission_fixed_minor: null,
      attribution_window_days: 30,
    },
  },
}

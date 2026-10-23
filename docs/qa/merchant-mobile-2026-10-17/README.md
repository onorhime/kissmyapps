# Merchant connection responsive acceptance — 17 October 2026

Completed locally in the in-app browser using the actual React merchant components inside an iframe with a measured responsive viewport. This was a responsive browser check, **not a physical-phone or mobile Safari test**.

The temporary fixture used synthetic merchant identity, session and gateway responses. It loaded no Supabase credentials and sent no email, Stripe request, payment or payout. No deployment or production setting was changed.

## Changes verified

- Standalone merchant branding remains legible on its light background.
- Admin merchant cards, notices and review panels follow the existing dark admin theme.
- Long business names, signed-in email addresses and account IDs wrap without widening the page.
- Narrow-screen actions stack, with all inspected recipient and admin buttons at least 44px high.
- Inputs and selects use 16px text on narrow screens; native selects stay within their container.

## Browser checks

| Screen / flow | Viewport | Result |
| --- | --- | --- |
| Recipient reviews exact account, confirms, sees connected state | 320px | Passed |
| Anonymous recipient enters email and reaches verification-code form | 390px | Passed; synthetic response, no email sent |
| Admin reviews renewal, confirms and receives replacement invitation link | 320px | Passed |
| Admin fills and submits a new merchant invitation | 320px | Passed; synthetic response |
| Horizontal overflow measurements | 320, 375, 390, 620 and 768px | No document overflow at each measured width |

Screenshots contain only synthetic local fixture data:

- [Recipient confirmation at 320px](recipient-confirmation-320.jpg)
- [Admin invitation at 320px](admin-invitation-320.jpg)

## Code checks

After the final presentation changes, the merchant connection and product configuration suites passed **23 tests**. `tsc -b` and focused Prettier checks passed. No auth, account-selection, checkout or commission behavior was changed by these layout fixes.

Real Stripe account selection, payment, commission and refund evidence is separate from this responsive acceptance. Hosted email delivery and physical-device keyboard/viewport behavior are not established by this fixture.

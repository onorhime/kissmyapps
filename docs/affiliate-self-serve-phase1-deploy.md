# Affiliate self-serve, Phase 1: deploy steps

Phase 1 lets a merchant connect their live Stripe account from the merchant console
(`#connections`) and lets KissMyApps record a receipt for each payment on that account.
Nothing here runs until the two flags below are set to `true`. Deploy only with the owner.

## What ships

| Piece | Where |
|---|---|
| Workspace to merchant link | `supabase/migrations/20261113100000_workspace_merchant_link.sql` |
| One-click connect RPCs | `supabase/migrations/20261113101000_workspace_stripe_connect.sql` |
| Payment receipts | `supabase/migrations/20261113110000_merchant_payment_events.sql` |
| Account events go to the active connection | `supabase/migrations/20261113120000_merchant_event_active_connection.sql` |
| Edge function `workspace-stripe-connect` | status, start, complete, disconnect |
| Edge function `connect-payments-webhook` | Stripe Connect webhook, receipts only |
| Console page | `src/merchant/screens/Connections.tsx` |

The admin invitation flow (`merchant-connect`) is unchanged and keeps working.

## Order

1. Apply the four migrations, in file order.
2. Set the function secrets (below). Set `CONSOLE_CONNECT_ORIGIN` even while the feature is
   off, or the console cannot read that it is off.
3. Deploy `workspace-stripe-connect` and `connect-payments-webhook`.
4. Release the dashboard build (the Connections page is part of the merchant console).
5. Do the Stripe dashboard steps (below), in live mode.
6. Set `CONSOLE_CONNECT_ENABLED=true` and `CONNECT_PAYMENTS_WEBHOOK_ENABLED=true`.

## Function secrets

| Secret | Value |
|---|---|
| `CONSOLE_CONNECT_ENABLED` | `true` to switch connecting on |
| `CONSOLE_CONNECT_PLATFORM_ACCOUNT` | the KissMyApps platform account, `acct_...` |
| `CONSOLE_CONNECT_CLIENT_ID` | the live Connect client id, `ca_...` |
| `CONSOLE_CONNECT_STRIPE_SECRET` | the live platform secret key, `sk_live_...` (a restricted key is refused) |
| `CONSOLE_CONNECT_ORIGIN` | `https://merchant.kissmyapps.dev` (no trailing slash) |
| `CONSOLE_CONNECT_CALLBACK_URL` | `https://merchant.kissmyapps.dev/` |
| `CONNECT_PAYMENTS_WEBHOOK_ENABLED` | `true` to switch receipts on |
| `CONNECT_PAYMENTS_WEBHOOK_SECRET` | the signing secret of the Connect webhook endpoint, `whsec_...` |

`CONSOLE_CONNECT_ALLOW_LOCAL` stays unset in production.

## Stripe dashboard, live mode

1. Connect settings, OAuth: add the redirect URI exactly as `CONSOLE_CONNECT_CALLBACK_URL`
   is written, and make sure OAuth for Standard accounts is on.
2. Webhooks: add an endpoint at
   `https://<project-ref>.supabase.co/functions/v1/connect-payments-webhook` that listens
   to events on **connected accounts**, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `payment_intent.succeeded`, `invoice.paid`, `charge.refunded`, `refund.created`,
   `refund.updated`, `charge.dispute.created`, `charge.dispute.closed`.
3. The existing `merchant-connect-webhook` endpoint must receive `account.updated` and
   `account.application.deauthorized` for the same platform account, so the console
   follows changes made on Stripe's side.

## First live check

This is the check the build plan calls out: that Stripe sends KissMyApps the payments a
merchant creates on their own.

1. Sign in to the console as a workspace owner, open Connections, connect a live Stripe
   account. The page should read "Connected. Watching for sales."
2. Make one real payment on that Stripe account, outside KissMyApps.
3. Within a minute the page should show "Payments seen: 1". If it stays at "Waiting for
   your first payment", the Connect webhook is not delivering that account's own
   payments, and the per-merchant webhook path (`external-commerce-webhook`) is the
   fallback for Phase 2.

## Known limits

- A subscription sale can count as more than one payment in "Payments seen", because the
  session, the invoice and the payment cannot be linked without reading Stripe. Phase 2
  reads Stripe when it turns receipts into orders.
- Renewal invoices usually carry no creator tag. Phase 2 ties renewals to the first sale.
- If a connection is refused after the merchant approved on Stripe (account not ready, or
  already connected elsewhere), the approval stays on Stripe's side until they connect
  again or remove the app in Stripe.
- While `CONNECT_PAYMENTS_WEBHOOK_ENABLED` is off the webhook answers 503 and Stripe
  retries, so events from the last few days arrive once it is switched on.

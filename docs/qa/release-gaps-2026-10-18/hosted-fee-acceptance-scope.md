# Hosted application-fee acceptance scope — 18 October 2026

## Verified and unverified states

The earlier real Stripe TEST referred purchase was USD 169 with a 25% / USD 42.25 application fee. Its commission and full purchase/application-fee refund were verified against the retained local test system. During this release, the real platform-origin application-fee event authenticated at the hosted endpoint, which returned unknown-order for the referred order because that fixture was intentionally not imported.

**Positive hosted referred application-fee reconciliation is not verified.** The product/merchant agreement and referred-order binding must first be configured for the intended hosted product. The owner wants to configure that commercial product and funnel personally. Existing commercial settings have not been replaced with local test terms.

## Why the local referred graph was not copied

A read-only inspection of the retained local PostgreSQL snapshot found a 19-row parent graph, including the three product/funnel/offer rows shared with the isolated organic fixture. It additionally requires synthetic merchant and signer identities, a merchant business and connection, an affiliate, click and acquisition, an enabled TEST receipt mapping, an agreement and commission rule, approved frozen terms, a signed document, and the referred order.

The signed document is explicitly a disposable test fixture: its digest is a placeholder, its storage metadata is synthetic, and its signature timestamps were backdated in the local fixture with the evidence guard temporarily disabled. Copying it into hosted production would misrepresent commercial evidence and is not an acceptable shortcut to positive acceptance. No part of that additional graph was imported, no Auth privileges were added, and no provider charge, refund or transfer was made during this research.

Private read-only dependency evidence is retained under `.cache/release-backups/20261018-hosted-fee-feasibility/`. The retained PostgreSQL cluster was started with no TCP listener and `default_transaction_read_only=on`, then stopped cleanly. No original fixture data was modified.

## Organic request identity correction

The organic historical Stripe TEST refund includes its original KMA operation ID in provider metadata. The initial minimal hosted routing fixture omitted that request row, correctly causing refund-evidence validation to reject the event.

The exact original operation was exported read-only to `.cache/release-backups/20261018-hosted-organic-acceptance/organic-refund-operation.private.json`. The sibling acceptance agent prepared `organic-refund-operation-fixture.sql`; this was independently compared against the original row. It preserves the request, operation/order IDs, amount and original first-attempt timestamp, resets only provider result/completion fields, and guards the insertion against an existing operation or an unexpected/non-TEST order.

That one request row restores identity needed to validate the actual provider receipt. It does not invent a paid/refunded fact. Its application and the resulting hosted acceptance outcome are recorded by the acceptance owner separately.

## Gate before financial activation

Complete the actual hosted product, merchant connection and signed commission agreement, then verify its referred payment, fee and refund reconciliation in the intended isolated TEST configuration. Keep public checkout and creator transfers disabled until the wider financial activation checklist is satisfied. This unverified positive referred-fee path is distinct from the gated code deployment and the successful hosted authentication/email checks.

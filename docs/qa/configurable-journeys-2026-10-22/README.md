# Configurable journeys: local acceptance

Date: 2026-10-22. Scope: local KMA implementation only. No hosted migrations,
deployment, provider changes, checkout activation or payout activation were made.

## Verified

- Native PostgreSQL audit: all 70 migrations applied; 60 database suites passed,
  zero failed or skipped. See `database-results.json`. The new configurable
  journey suite includes 75 assertions.
- Final targeted frontend run: 9 test files, 81 tests passed. It includes the
  journey editor, configured reports, gateway, creator reporting and product
  configuration. Save-before-publish and independent journey-version selection
  have regression coverage.
- Production build, scoped TypeScript/lint checks and final formatting check
  passed. The build retains the existing large-bundle advisory.
- Independent code review found no outstanding P1/P2 issue.
- Browser acceptance used the disposable local PostgreSQL fixture and real
  local RPC bridge. An admin created, saved and published a generic course
  journey: Trial started → First project created.
- Four synthetic events represented two distinct people: one completed the
  stages in order, the other in reverse order. The creator report correctly
  showed two people at each stage, 1/2 (50%) ordered conversion and one person
  completing the path. No webinar stages were injected into this product.
- Browser console errors: none. See `local-events.json` and
  `creator-generic-desktop.png`.

The browser fixture submits synthetic events through the local SQL ingress;
this is not evidence of hosted HMAC delivery or a live product integration.
No mobile acceptance or new hosted provider test was performed in this scope.

## Release boundary

Migration 70 and the frontend still require deployment. A product's authorized
KMA owner/operations admin can define its stages and publish them; the product
must also send the matching signed event keys through its own approved binding.
This work does not add merchant self-service administration. Existing commerce,
commission, checkout and payout controls remain separate from reporting.

Local preview: http://127.0.0.1:5189/funnel-metrics-local.html

Implementation guide: [Configurable funnel journeys](../../configurable-funnel-journeys.md).

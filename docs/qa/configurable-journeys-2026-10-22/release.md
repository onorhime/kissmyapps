# Configurable journeys: hosted release

Released on 22 October 2026. This record supplements the earlier local acceptance
in [README.md](README.md); that evidence and its stated testing boundaries are
preserved unchanged. The sanitized machine-readable receipt is
[release.json](release.json).
The observed signed-in Safari UI checks are recorded in
[hosted-ui.json](hosted-ui.json).

## Deployed

- Database migration 70, `20261022120000_configurable_funnel_journeys`, applied
  successfully at 17:06 UTC after a successful rollback-only rehearsal.
- KMA dashboard release
  `20261022T170339Z-configurable-journeys-961e4a4a1384` is healthy. Its previous
  release remains available for rollback.
- Two definition tables and the new admin RPCs support explicit, editable,
  versioned journeys. One previously configured webinar funnel was imported as
  visible version 1. Other funnels did not acquire hidden webinar stages.
- No Edge Function release or provider configuration change was required.

## Hosted verification

- **78 of 78 frontend HTTP, asset and expected-denial checks passed** across
  the admin and creator hosts. Production preview remains disabled, and the
  production environment matches the previous release.
- The transactional migration preserved all rows in **117 existing tables**,
  **338 unrelated function definitions**, previous migration history, cron
  configuration, secret digests and deployed Edge Function inventory. Fifteen
  unrelated containers were preserved during frontend cutover.
- Read-only RPC checks used existing authorized accounts. The admin report
  returned the explicit TEST webinar journey, version 1, with **17 stages,
  9 conversion rates, 5 paths and the existing 3 custom cards**.
- Creator reporting remained scoped to that creator; overriding affiliate scope
  and accessing the admin definition RPC were denied. Anonymous definition and
  report calls were denied. A separate existing unconfigured funnel correctly
  returned no configured stages, rates or paths.
- The first RPC probe hit a permission error because the verifier attempted to
  call an intentionally private helper as an authenticated browser role. The
  verifier was corrected and the final probe passed. No application or migration
  correction was required; the original error evidence was retained privately.
- The RPC probe ran in a read-only transaction ending in rollback and made zero
  business writes. Provider-managed backup inventory showed eight backups; PITR
  was not enabled.
- A signed-in production admin session in Safari displayed the new journey
  editor and loaded the TEST report: “TEST data — no real earnings”, configured
  journey version 1, all 17 stages, 9 rates and 5 paths. The selected cohort had
  no classified creator clicks: stages showed zero, rates showed no eligible
  audience, and the three custom cards showed “Awaiting data”. No settings were
  saved or published, and no events were sent. This was observed UI state; the
  screenshot API returned an unusable warped window thumbnail, which is not
  used as visual proof.
- The final read-only VPS check confirmed the current release and a healthy
  running dashboard, with **2.89 GiB available**. No cleanup was needed.

## Activation and remaining checks

Checkout and creator payouts remain disabled. The five guarded activation flags
for managed checkout, creator transfers, creator Connect, external commerce
webhooks and live merchant Connect remained false. Publishing a reporting
definition does not enable any financial action.

**Actual SpeakSix TEST event delivery remains disabled.** The next integration
step is to configure its approved TEST event binding and send controlled,
attributed events to verify the resulting journey. This deployment does not
establish a hosted live journey from click through payment or refund, nor does it
prove Zoom attendance delivery. No synthetic production customers, payments,
refunds, payouts or event fixtures were created by these release checks.

The earlier local result remains 81 frontend tests, 60 database suites and a
successful production build; those tests were not rerun merely to write this
release record.

Raw release packets, account identifiers and diagnostic responses remain in the
private release backup directory. This public QA record contains no credentials,
secret digests or user identifiers.

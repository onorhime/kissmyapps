# Where everything lives

All of KissMyApps is in this one repository and goes out in one release
([RELEASING.md](RELEASING.md)). The partner dashboard, the admin console and the merchant
console are one React app and one build; the host name picks which one opens.

| Part                                               | In this repo                                                                    | Runs on                                                                               | Ships with                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Partner dashboard                                  | `src/features/partner`, `src/App.tsx`                                           | `partners.kissmyapps.dev` (VPS container `kissmyapps-dashboard`)                      | release: dashboard                         |
| Admin console                                      | `src/features/admin`, `src/App.tsx`                                             | `admin.kissmyapps.dev` (same container)                                               | release: dashboard                         |
| Merchant console (analytics, replays, attribution) | `src/merchant`, opened from `src/main.tsx`                                      | `merchant.kissmyapps.dev` (same container, its own lazy-loaded chunk)                 | release: dashboard                         |
| Web SDK (`kma.js`, `kma-replay.js`)                | `integrations/analytics-web`, built by `scripts/build-analytics-sdk.mjs`        | `merchant.kissmyapps.dev/sdk/*`                                                       | release: dashboard                         |
| Funnel integration kit and docs page               | `integrations/funnel`                                                           | `/developers/funnels` on the dashboard hosts                                          | release: dashboard                         |
| Database (tables, RLS, RPCs)                       | `supabase/migrations`, tests in `supabase/tests`                                | Supabase project `mmyruzjemjecqyivhrgr`                                               | release: database                          |
| Edge Functions (30)                                | `supabase/functions`, settings in `supabase/config.toml`                        | Supabase                                                                              | release: functions                         |
| Events relay (adds each visitor's place)           | `deploy/geo-relay`                                                              | VPS container `kissmyapps-geo`, behind `events.kissmyapps.dev`                        | release: VPS services                      |
| Link service (merchant link domains)               | `deploy/link-service`                                                           | VPS container `kissmyapps-links`, behind `*.go.kissmyapps.dev` and merchants' domains | release: VPS services                      |
| Compose file and dashboard web server              | `deploy/hostinger/compose.yaml`, `deploy/hostinger/dashboard.Caddyfile`         | `/srv/kissmyapps/deploy` on the VPS                                                   | release: VPS services                      |
| Edge routes for every KissMyApps host              | `deploy/hostinger/Caddyfile.kissmyapps` (full snapshot: `Caddyfile.production`) | the shared `dramapal-caddy-1` on the VPS                                              | merged by hand; the release checks it      |
| Database maintenance jobs                          | `deploy/hostinger/agreement-maintenance.sql`, `analytics-maintenance.sql`       | Supabase pg_cron                                                                      | applied once, by hand                      |
| Auth email templates                               | `supabase/templates`                                                            | Supabase Auth settings                                                                | pasted into the dashboard when they change |
| iOS, Android and Flutter SDKs                      | `integrations/analytics-mobile`                                                 | public mirror `onorhime/kissmyapps-mobile` (SwiftPM, JitPack), pub.dev `kissmyapps`   | published per SDK version                  |
| React Native SDK                                   | `integrations/analytics-react-native`                                           | npm `@kissmyappss/react-native`                                                       | published per SDK version                  |
| Standalone Vercel tracking gateway                 | `deploy/tracking-gateway`                                                       | not deployed: the VPS serves `go.kissmyapps.dev`                                      | —                                          |
| Release tool                                       | `scripts/kma-release.mjs`, `deploy/release.config.json`                         | the machine that releases                                                             | —                                          |
| Design skills for UI work                          | `.claude/skills`                                                                | —                                                                                     | —                                          |
| CI                                                 | `.github/workflows/mobile-sdks.yml`                                             | GitHub Actions                                                                        | —                                          |

`onorhime/kissmyapps-mobile` is a copy, not a second source: it holds
`integrations/analytics-mobile` at its root because Swift Package Manager and JitPack need
it there. Change the SDKs here and mirror them on release.

The dated `*_QA.md`, `RELEASE_EVIDENCE_*.md` and audit files at the top level are the
history of earlier releases; current procedures are in `docs/`.

## Kept out of the repo on purpose

- Secrets: Edge Function secrets in Supabase, `/srv/kissmyapps/*.env` on the VPS, and the
  owner's local backups in `.secrets/` (ignored by git).
- The live edge Caddyfile, which belongs to the shared DramaPal stack.
- DNS (Fozzy), Stripe and Supabase Auth settings.

## Connected, but separate projects

These call KissMyApps but are not part of it, and keep their own code and deploys:

- **SpeakSix** (`onorhime/Bclearn-Pilot`): uses KissMyApps managed checkout and tracking.
- **BC Learn funnel** (Vercel `bc-learn-funnel`): sends funnel events and the merchant SDK's
  events to KissMyApps.

# Interaction audit regression fixture

Local-only, synthetic data. The gateway contains no network calls and does not use a Supabase or Stripe client. Unsupported operations fail locally. It is not an application build entrypoint and must not be deployed.

The original characterization tests now assert the corrected behavior: preserved drafts/focus, visible dialogs, consistent pending locks, read-only refresh retry, first-invalid-field focus, edit cancellation, and authorization loss. These are synthetic UI regressions, not proof of live billing or legal actions.

Run:

```sh
pnpm exec vitest run integrations/ui-interaction-audit --maxWorkers=1
pnpm exec tsc -p integrations/ui-interaction-audit/tsconfig.json
VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= VITE_SUPABASE_PUBLISHABLE_KEY= pnpm exec vite --host 127.0.0.1 --port 5191 --strictPort
```

Open `http://127.0.0.1:5191/integrations/ui-interaction-audit/index.html`.

1. Enter an unsaved Funnel name.
2. Expand Billing offers; click Review activation. A focused modal opens within the viewport on desktop and mobile. Cancel returns focus to the opener.
3. Confirm the synthetic activation. During the 1.5-second read delay, the page, unrelated funnel draft, and expanded Billing section stay mounted. A top-right success notification appears; the write is not repeated during the read.
4. Reload this isolated page to reset its in-memory data. Expand Billing, enter a separate create-offer draft, and click Edit draft. The actual editing field receives focus. Cancel edit restores the separate create draft.

All records and mutations here are fake. Do not use real partner data, passwords, legal evidence, or checkout identifiers in this fixture.

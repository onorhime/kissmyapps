// This isolated acceptance script is not imported by deployed handlers.
import { createCreatorConnectHandler } from "./index.ts";
import type { CreatorAuthentication } from "./auth-policy.ts";
import { createCreatorPayoutWorker } from "../creator-payout-worker/index.ts";
import { createCreatorConnectWebhook } from "../creator-connect-webhook/index.ts";
import { createExternalCommerceWebhook } from "../external-commerce-webhook/index.ts";
import { MerchantProvider } from "../external-commerce/provider.ts";
import {
  ConnectProvider,
  type JsonObject,
  type TransferJob,
} from "./provider.ts";
import { assertEquals, config, FakeStripe } from "./test-support.ts";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
const socket = Deno.env.get("KMA_CREATOR_TEST_SOCKET") ?? "";
if (
  !/^\/(?:private\/)?tmp\/kma-(?:creator-e2e|all-sql-db)\.[A-Za-z0-9]+$/.test(
    socket,
  )
) {
  throw Error("An isolated creator fixture socket is required.");
}
const owner = "ac570000-0000-4000-8000-000000000011",
  creatorUser = "ac570000-0000-4000-8000-000000000012",
  other = "ac570000-0000-4000-8000-000000000013";
// Only this disposable fixture supplies authentication directly. Production
// verifies the bearer token and its actual AMR; this is not login/MFA acceptance.
const fixtureAuthentication = (
  userId = creatorUser,
): CreatorAuthentication => ({
  userId,
  assuranceLevel: "aal1",
  methods: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
  hasVerifiedMfa: false,
});
const literal = (value: unknown) =>
  `'${
    String(typeof value === "object" ? JSON.stringify(value) : value)
      .replaceAll("'", "''")
  }'`;
async function sql(
  statement: string,
  role = "service_role",
  actor = creatorUser,
): Promise<unknown> {
  const query = `begin;set local role "${
    role.replaceAll('"', '""')
  }";set local request.jwt.claims=${
    literal({ sub: actor, role, amr: fixtureAuthentication(actor).methods })
  };${statement};commit;`;
  const result = await new Deno.Command(
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    {
      args: [
        "-h",
        socket,
        "-d",
        "postgres",
        "-U",
        Deno.env.get("USER")!,
        "-XAtq",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        query,
      ],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "piped",
    },
  ).output();
  if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
  const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
  return lines.at(-1) ? JSON.parse(lines.at(-1)!) : null;
}
const rpc = (
  name: string,
  input: unknown,
  role = "service_role",
  actor = creatorUser,
) => sql(`select public.${name}(${literal(input)}::jsonb)`, role, actor);
const fake = new FakeStripe();
fake.accounts.clear();
fake.platformId = "acct_fixture";
const binding = { ...config, platformAccountId: "acct_fixture" },
  bindings = () => new Map([["fixture", binding]]);
const provider = (c: typeof binding) => new ConnectProvider(c, fake.fetch);
const context = async (actor = creatorUser) =>
  await sql(
    `select public.creator_connect_context('acct_fixture',false)`,
    "authenticated",
    actor,
  ) as JsonObject;
const handler = createCreatorConnectHandler({
  bindings,
  authenticate: () => Promise.resolve(fixtureAuthentication()),
  context: async () => await context() as never,
  reserve: async (c, country, actorUserId) =>
    await rpc("reserve_creator_connect_account", {
      account_key: c.account_key,
      country,
      actor_user_id: actorUserId,
    }) as never,
  persist: async (c, snapshot, at) => {
    await rpc("set_creator_connect_account", {
      affiliate_id: c.affiliate_id,
      platform_account_id: c.platform_account_id,
      livemode: c.livemode,
      account_key: c.account_key,
      connect_account_id: snapshot.account_id,
      charges_enabled: snapshot.charges_enabled,
      payouts_enabled: snapshot.payouts_enabled,
      transfers_enabled: snapshot.transfers_active,
      details_submitted: snapshot.details_submitted,
      requirements_due: snapshot.requirements_due,
      disabled_reason: snapshot.disabled_reason,
      verified_at: at,
    });
  },
  provider,
});
const req = (action: string) =>
  new Request("https://local.invalid/connect", {
    method: "POST",
    headers: {
      Authorization: "Bearer fixture",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, binding_id: "fixture", country: "US" }),
  });
// Synthetic profile data lives only in this disposable database. Exercise the
// actual service-side snapshot sourcing rather than injecting a prefill object.
await sql(
  `update auth.users set email_confirmed_at=clock_timestamp() where id=${
    literal(creatorUser)
  };update public.affiliates set entity_type='company',legal_name='Native Creator Ltd',website_url='https://native-creator.example.invalid' where id='ac570000-0000-4000-8000-000000000003'`,
  Deno.env.get("USER")!,
);
const setup = await handler(req("session"));
assertEquals(setup.status, 200);
const setupBody = await setup.json();
assertEquals(setupBody.bindings[0].status, "needs_information");
assertEquals(
  setupBody.account_session.client_secret,
  "local_session_fixture_secret",
);
assertEquals(setupBody.account_session.connected_account_id, "acct_newcreator");
const stored = await context();
const createRequest = fake.calls.find((call) =>
  call.path === "accounts" && call.method === "POST"
)!;
assertEquals(
  createRequest.body.get("email"),
  "settlement-partner@example.invalid",
);
assertEquals(createRequest.body.get("company[name]"), "Native Creator Ltd");
assertEquals(
  createRequest.body.get("business_profile[url]"),
  "https://native-creator.example.invalid",
);
assertEquals(createRequest.body.get("business_type"), "company");
assertEquals(
  JSON.stringify(setupBody).includes("settlement-partner@example.invalid"),
  false,
);
assertEquals(stored.connect_account_id, "acct_newcreator");
assertEquals(
  JSON.stringify(stored).includes("local_session_fixture_secret"),
  false,
);
const account = fake.accounts.get("acct_newcreator")!;
Object.assign(account, {
  details_submitted: true,
  payouts_enabled: true,
  capabilities: { transfers: "active" },
  requirements: { currently_due: [], past_due: [] },
});
assertEquals(
  (await (await handler(req("status"))).json()).bindings[0].status,
  "ready",
);
assertEquals((await context()).status, "ready");
await sql(
  `update public.affiliates set legal_name='Changed Profile Ltd' where id='ac570000-0000-4000-8000-000000000003'`,
  Deno.env.get("USER")!,
);
assertEquals((await handler(req("session"))).status, 200);
assertEquals(
  fake.calls.filter((call) =>
    call.path.startsWith("accounts") && call.method === "POST"
  ).length,
  1,
);
let denied = false;
try {
  await context(other);
} catch {
  denied = true;
}
assertEquals(denied, true);
const workspace = await rpc(
  "get_admin_external_settlement_workspace",
  {},
  "authenticated",
  owner,
) as JsonObject;
const batch = (workspace.batches as JsonObject[])[0];
for (
  const [action, revision] of [["review_batch", 1], [
    "approve_batch",
    2,
  ]] as const
) {
  await rpc(
    "perform_admin_external_settlement_action",
    {
      request_id: crypto.randomUUID(),
      action,
      id: batch.id,
      expected_revision: revision,
      reason: "Native edge fake-provider acceptance",
    },
    "authenticated",
    owner,
  );
}
const worker = createCreatorPayoutWorker({
  authenticate: () => {},
  bindings,
  provider,
  processCommissions: () =>
    sql("select public.process_external_commissions(100)"),
  reconciliationJobs: async () =>
    await sql(
      "select coalesce(jsonb_agg(value),'[]') from public.claim_creator_reconciliation_jobs('acct_fixture',false,10) value",
    ) as TransferJob[],
  reconcile: async (job, providerId, p) => {
    const transfer = await p.transfer(
      job.kind === "transfer" ? providerId : job.transfer_id!,
    );
    return await rpc(
      job.kind === "transfer"
        ? "reconcile_creator_transfer_evidence"
        : "reconcile_creator_reversal_evidence",
      {
        id: job.id,
        platform_account_id: job.platform_account_id,
        livemode: job.livemode,
        provider_id: providerId,
        destination: job.destination,
        amount_minor: job.amount_minor,
        currency: job.currency,
        observed_at: new Date().toISOString(),
        ...(job.kind === "transfer"
          ? {
            transfer_group: job.transfer_group,
            amount_reversed: transfer.amount_reversed,
          }
          : { transfer_id: job.transfer_id }),
      },
    );
  },
  claim: async () =>
    await sql(
      "select coalesce(jsonb_agg(value),'[]') from public.claim_creator_transfer_jobs('acct_fixture',false,2,300) value",
    ) as TransferJob[],
  beginAttempt: async (job) =>
    await rpc("begin_creator_transfer_attempt", {
      id: job.id,
      lease_token: job.lease_token,
    }) as TransferJob,
  account: async (j) =>
    await sql(
      `select jsonb_build_object('affiliate_id',affiliate_id,'account_key',id) from public.external_creator_accounts where connect_account_id=${
        literal(j.destination)
      } and platform_account_id='acct_fixture' and not livemode`,
    ) as never,
  finish: async (input) => {
    await rpc("finish_creator_transfer_job", input);
  },
});
const tick = () =>
  worker(new Request("https://local.invalid/worker", { method: "POST" }));
// Read-only onboarding failures must not consume the provider's idempotency
// retry window. Age this disposable queued job, then recheck before readiness.
account.payouts_enabled = false;
assertEquals((await tick()).status, 200);
await sql(
  "update public.external_settlement_jobs set created_at=clock_timestamp()-interval '2 days',next_attempt_at=clock_timestamp()-interval '1 second' where kind='transfer' returning to_jsonb(id)",
  Deno.env.get("USER")!,
);
assertEquals((await tick()).status, 200);
assertEquals(
  await sql(
    "select to_jsonb(first_attempt_at is null) from public.external_settlement_jobs where kind='transfer'",
  ),
  true,
);
assertEquals(
  await sql(
    `select to_jsonb(status) from public.external_settlement_batches where id=${
      literal(batch.id)
    }::uuid`,
  ),
  "approved",
);
assertEquals(
  fake.calls.filter((c) => c.path === "transfers" && c.method === "POST")
    .length,
  0,
);
const preflightAttempts = await sql(
  "select to_jsonb(attempt_count) from public.external_settlement_jobs where kind='transfer'",
) as number;
await sql(
  "update public.external_settlement_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where kind='transfer' returning to_jsonb(id)",
  Deno.env.get("USER")!,
);
account.payouts_enabled = true;
fake.ambiguousNextTransfer = true;
assertEquals((await tick()).status, 200);
// Retry immediately is blocked by actual DB backoff; make this isolated fixture
// due before continuing rather than sleeping or disabling the production bound.
assertEquals((await tick()).status, 200);
assertEquals(
  await sql(
    "select to_jsonb(attempt_count) from public.external_settlement_jobs where kind='transfer'",
  ),
  preflightAttempts + 1,
);
await sql(
  "update public.external_settlement_jobs set next_attempt_at=clock_timestamp()-interval '1 second',first_attempt_at=clock_timestamp()-interval '24 hours' where state='pending' returning to_jsonb(id)",
  Deno.env.get("USER")!,
);
assertEquals((await tick()).status, 200); // Expired attempt becomes read-only reconciliation.
assertEquals(
  await sql(
    "select to_jsonb(state) from public.external_settlement_jobs where kind='transfer'",
  ),
  "reconcile",
);
assertEquals((await tick()).status, 200); // Exact receipt completes the actual DB job.
assertEquals(
  fake.calls.filter((c) => c.path === "transfers" && c.method === "POST")
    .length,
  1,
);
assertEquals(
  await sql(
    `select to_jsonb(status) from public.external_settlement_batches where id=${
      literal(batch.id)
    }::uuid`,
  ),
  "transferred",
);
assertEquals(
  await sql(
    "select to_jsonb(sum(amount_minor)) from public.external_commission_ledger",
  ),
  0,
);
const webhook = createCreatorConnectWebhook({
  bindings,
  provider,
  account: async (_c, id) =>
    await sql(
      `select jsonb_build_object('id',id,'affiliate_id',affiliate_id,'connect_account_id',connect_account_id) from public.external_creator_accounts where connect_account_id=${
        literal(id)
      } and platform_account_id='acct_fixture' and not livemode`,
    ) as never,
  job: async (_c, id) =>
    await sql(
      `select to_jsonb(j) from public.external_settlement_jobs j where id=${
        literal(id)
      }::uuid`,
    ) as never,
  persist: async (input) =>
    await rpc("ingest_creator_connect_event", input) as never,
});
const merchantBinding = {
  secret: "local-native-fixture-hmac-not-used",
  productId: "ac570000-0000-4000-8000-000000000001",
  funnelId: "ac570000-0000-4000-8000-000000000002",
  accountId: "acct_fixture",
  livemode: false,
  stripeReadKey: "rk_test_localfixture",
  webhookSecret: config.webhookSecret,
};
const merchantWebhook = createExternalCommerceWebhook({
  enabled: () => true,
  bindings: () => new Map([["fixture", merchantBinding]]),
  provider: (b) => new MerchantProvider(b, fake.fetch),
  persist: async (input) =>
    await rpc("ingest_external_merchant_adjustment", input) as never,
});
async function hook(event: JsonObject, target = webhook) {
  const body = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000),
    signature = bytesToHex(
      await hmacSha256(config.webhookSecret, `${timestamp}.${body}`),
    );
  return await target(
    new Request("https://local.invalid/hook?binding_id=fixture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${timestamp},v1=${signature}`,
      },
      body,
    }),
  );
}
fake.payouts.set("acct_newcreator:po_fixture", {
  id: "po_fixture",
  livemode: false,
  status: "failed",
  amount: 2000,
  currency: "usd",
  failure_code: "account_closed",
});
const bankEvent = {
  id: "evt_bankfailure",
  type: "payout.failed",
  livemode: false,
  account: "acct_newcreator",
  data: { object: { id: "po_fixture" } },
};
assertEquals((await hook(bankEvent)).status, 200);
assertEquals((await (await hook(bankEvent)).json()).duplicate, true);
const rows = await sql(
  "select public.get_partner_creator_bank_payouts()",
  "authenticated",
) as JsonObject[];
assertEquals(rows[0].status, "failed");
assertEquals(
  await sql(
    "select public.get_partner_creator_bank_payouts()",
    "authenticated",
    other,
  ),
  [],
);
// A full refund in the merchant's platform feed freezes/reverses the actual
// order, and the same real worker recovers the transferred commission once.
fake.charges.set("ch_settle2", {
  id: "ch_settle2",
  livemode: false,
  payment_intent: "pi_settle2",
  amount: 10000,
  amount_refunded: 10000,
  currency: "usd",
  paid: true,
});
const paidExternalId = await sql(
  "select to_jsonb(external_order_id) from public.external_commerce_orders where stripe_payment_intent_id='pi_settle2'",
);
fake.payments.set("pi_settle2", {
  id: "pi_settle2",
  livemode: false,
  status: "succeeded",
  amount: 10000,
  amount_received: 10000,
  currency: "usd",
  metadata: {
    purpose: "speaksix_marathon",
    order_id: paidExternalId,
    stripe_account_id: "acct_fixture",
  },
});
fake.refunds.set("re_settle2", {
  id: "re_settle2",
  status: "succeeded",
  charge: "ch_settle2",
  payment_intent: "pi_settle2",
  amount: 10000,
  currency: "usd",
  created: Math.floor(Date.now() / 1000),
});
assertEquals(
  (await hook({
    id: "evt_directrefund",
    type: "charge.refunded",
    livemode: false,
    data: { object: { id: "ch_settle2" } },
  }, merchantWebhook)).status,
  200,
);
assertEquals((await tick()).status, 200);
assertEquals(fake.reversals.size, 1);
assertEquals(
  await sql(
    "select to_jsonb(sum(amount_minor)) from public.external_commission_ledger",
  ),
  0,
);
assertEquals(
  await sql(
    "select to_jsonb(count(*)) from public.payouts",
    Deno.env.get("USER")!,
  ),
  0,
);
// The signed provider feed wins even if attribution purchase delivery is delayed.
const externalOrder = crypto.randomUUID(),
  occurredAt = new Date().toISOString();
fake.charges.set("ch_beforepurchase", {
  id: "ch_beforepurchase",
  livemode: false,
  payment_intent: "pi_beforepurchase",
  amount: 10000,
  amount_refunded: 10000,
  currency: "usd",
  paid: true,
});
fake.payments.set("pi_beforepurchase", {
  id: "pi_beforepurchase",
  livemode: false,
  status: "succeeded",
  amount: 10000,
  amount_received: 10000,
  currency: "usd",
  metadata: {
    purpose: "speaksix_marathon",
    order_id: externalOrder,
    stripe_account_id: "acct_fixture",
  },
});
fake.refunds.set("re_beforepurchase", {
  id: "re_beforepurchase",
  status: "succeeded",
  charge: "ch_beforepurchase",
  payment_intent: "pi_beforepurchase",
  amount: 10000,
  currency: "usd",
  created: Math.floor(Date.now() / 1000),
});
assertEquals(
  (await hook({
    id: "evt_beforepurchase",
    type: "charge.refunded",
    livemode: false,
    data: { object: { id: "ch_beforepurchase" } },
  }, merchantWebhook)).status,
  200,
);
assertEquals(
  await sql(
    "select to_jsonb(count(*)) from public.external_merchant_adjustment_receipts where payment_intent_id='pi_beforepurchase' and applied_at is null",
  ),
  1,
);
await rpc("ingest_external_commerce", {
  product_id: "ac570000-0000-4000-8000-000000000001",
  funnel_id: "ac570000-0000-4000-8000-000000000002",
  attribution_sha256: "a".repeat(64),
  provider_occurred_at: occurredAt,
  input: {
    event_id: crypto.randomUUID(),
    kind: "purchase",
    click_id: "opaque_fixture_click_123456",
    occurred_at: occurredAt,
    order_id: externalOrder,
    checkout_session_id: "cs_test_beforepurchase",
    payment_intent_id: "pi_beforepurchase",
    account_id: "acct_fixture",
    livemode: false,
    amount_minor: 10000,
    currency: "USD",
    attribution: {
      kmaClick: "opaque_fixture_click_123456",
      status: "unverified",
    },
  },
});
await rpc("record_external_commission_basis", {
  external_order_id: externalOrder,
  stripe_account_id: "acct_fixture",
  livemode: false,
  eligible_basis_minor: 8000,
  total_minor: 10000,
  currency: "USD",
  basis_policy: "post_discount_excluding_tax_shipping",
  verified_at: new Date().toISOString(),
});
await sql("select public.process_external_commissions(100)");
assertEquals(
  await sql(
    "select to_jsonb(status) from public.external_commission_awards where order_id=(select id from public.external_commerce_orders where stripe_payment_intent_id='pi_beforepurchase')",
  ),
  "reversed",
);
assertEquals(
  await sql(
    "select to_jsonb(sum(amount_minor)) from public.external_commission_ledger",
  ),
  0,
);
console.log(JSON.stringify({
  passed: true,
  actual_database: true,
  fake_provider: true,
  checks: [
    "embedded_onboarding",
    "session_secrets_not_persisted",
    "fresh_account_status",
    "creator_isolation",
    "manual_review_approval",
    "preflight_does_not_start_provider_window",
    "ambiguous_transfer_recovery",
    "retry_backoff",
    "expired_readonly_reconciliation",
    "refund_before_attributed_purchase",
    "single_transfer",
    "payout_failed",
    "webhook_replay",
    "direct_refund",
    "single_reversal",
    "legacy_money_untouched",
  ],
}));

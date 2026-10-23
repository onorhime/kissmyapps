// Local acceptance adapter only: real handler/provider + disposable SQL identity.
// No deployed entrypoint imports this file; secrets arrive on stdin, never env/files.
import {
  createCreatorConnectHandler,
  type CreatorContext,
} from "../supabase/functions/creator-connect/index.ts";
import {
  ConnectProvider,
  type JsonObject,
} from "../supabase/functions/creator-connect/provider.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";
import type { CreatorAuthentication } from "../supabase/functions/creator-connect/auth-policy.ts";
import { FakeStripe } from "../supabase/functions/creator-connect/test-support.ts";
import {
  allowedOnboardingRequest,
  browserOrigin,
  validateTestCredentials,
} from "./creator-connect-browser-policy.mjs";

const reader = Deno.stdin.readable.getReader();
let raw = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  raw += new TextDecoder().decode(value);
  if (raw.length > 16_384) throw Error("Local configuration is too large.");
}
const input = JSON.parse(raw);
raw = "";
const credentials = validateTestCredentials(input.credentials);
if (
  !/^\/tmp\/kma-creator-browser\.[A-Za-z0-9]+$/.test(input.socket) ||
  !/^[a-f0-9]{64}$/.test(input.token) ||
  !["fake", "stripe-test"].includes(input.mode) ||
  (input.expectedAccount != null &&
    !/^acct_[A-Za-z0-9]+$/.test(input.expectedAccount)) ||
  (input.runId != null && !/^[a-f0-9]{24}$/.test(input.runId))
) throw Error("Invalid local fixture configuration.");
const expectedAccount: string | null = input.expectedAccount ?? null;
const creatorUser = "ac570000-0000-4000-8000-000000000012";
// Local acceptance identity only. This never verifies a real user's password or
// MFA and is not imported by any deployed authentication implementation.
const fixtureAuthentication = (): CreatorAuthentication => ({
  userId: creatorUser,
  assuranceLevel: "aal1",
  methods: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
  hasVerifiedMfa: false,
});
const literal = (value: unknown) =>
  `'${
    String(typeof value === "object" ? JSON.stringify(value) : value)
      .replaceAll("'", "''")
  }'`;
const sql = async (statement: string, role = "service_role") => {
  const query = `begin;set local role ${role};set local request.jwt.claims=${
    literal({ sub: creatorUser, role, amr: fixtureAuthentication().methods })
  };${statement};commit;`;
  const result = await new Deno.Command(
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    {
      args: [
        "-h",
        input.socket,
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
  if (!result.success) {
    throw Error("Disposable creator database rejected the operation.");
  }
  const line = new TextDecoder().decode(result.stdout).trim().split("\n").at(
    -1,
  );
  return line ? JSON.parse(line) : null;
};
const rpc = (name: string, value: unknown) =>
  sql(`select public.${name}(${literal(value)}::jsonb)`);
const config = {
  platformAccountId: credentials.platformAccountId,
  livemode: false,
  secret: credentials.secretKey,
  publishableKey: credentials.publishableKey,
  webhookSecret: "whsec_local_unused",
  origin: browserOrigin,
  returnUrl: `${browserOrigin}/creator-connect-local.html?returned=1`,
  refreshUrl: `${browserOrigin}/creator-connect-local.html?refresh=1`,
  countryPolicy: { type: "domestic" as const },
  transfersEnabled: false,
};
const fake = new FakeStripe();
fake.accounts.clear();
fake.platformId = credentials.platformAccountId;
const counts = {
  reads: 0,
  accountCreates: 0,
  accountSessions: 0,
  deniedProviderCalls: 0,
  successfulSessions: 0,
  statusChecks: 0,
  providerHttpFailures: 0,
};
const providerTimings: Array<Record<string, unknown>> = [];
const requestTimings: Array<Record<string, unknown>> = [];
let creationPrefill: Record<string, unknown> | null = null;
const recordTiming = (
  rows: Array<Record<string, unknown>>,
  row: Record<string, unknown>,
) => {
  rows.push(row);
  if (rows.length > 100) rows.shift();
};
const transport: typeof fetch = async (address, init) => {
  if (!allowedOnboardingRequest(String(address), init?.method ?? "GET")) {
    counts.deniedProviderCalls++;
    throw Error("Only test onboarding provider requests are permitted.");
  }
  const method = init?.method ?? "GET";
  const path = new URL(String(address)).pathname;
  if (expectedAccount && method === "POST" && path === "/v1/accounts") {
    counts.deniedProviderCalls++;
    throw Error(
      "Account creation is forbidden while resuming an existing creator.",
    );
  }
  if ((init?.method ?? "GET") === "GET") counts.reads++;
  else if (new URL(String(address)).pathname === "/v1/accounts") {
    counts.accountCreates++;
    const fields = new URLSearchParams(String(init?.body ?? ""));
    creationPrefill = {
      confirmedSyntheticEmail:
        fields.get("email") === "creator.prefill@example.com",
      storedEntityType: fields.get("business_type") === "individual",
      individualEmail:
        fields.get("individual[email]") === "creator.prefill@example.com",
      inventedIndividualName: fields.has("individual[first_name]") ||
        fields.has("individual[last_name]"),
      transfersOnly:
        fields.get("capabilities[transfers][requested]") === "true" &&
        !fields.has("capabilities[card_payments][requested]"),
    };
  } else counts.accountSessions++;
  const started = Date.now();
  const kind = path === "/v1/account_sessions"
    ? "account_session"
    : path === "/v1/accounts"
    ? "account_create"
    : "provider_read";
  try {
    const response = await (input.mode === "fake"
      ? fake.fetch(address, init)
      : fetch(address, init));
    if (!response.ok) {
      counts.providerHttpFailures++;
    }
    recordTiming(providerTimings, {
      kind,
      method,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      status: response.status,
    });
    return response;
  } catch (error) {
    counts.providerHttpFailures++;
    recordTiming(providerTimings, {
      kind,
      method,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      status: null,
    });
    throw error;
  }
};
const provider = () => new ConnectProvider(config, transport);
await provider().verifyPlatform(); // Read-only account identity + test balance assertion.
const context = async () => {
  const value = await sql(
    `select public.creator_connect_context(${
      literal(config.platformAccountId)
    },false)`,
    "authenticated",
  ) as CreatorContext;
  if (expectedAccount && value.connect_account_id !== expectedAccount) {
    throw Error(
      "The existing creator mapping no longer matches the approved resume account.",
    );
  }
  return value;
};
if (expectedAccount) await context();
const handler = createCreatorConnectHandler({
  bindings: () => new Map([["local_test", config]]),
  authenticate: (authorization) => {
    if (authorization !== `Bearer ${input.token}`) {
      throw new RequestError(
        401,
        "unauthorized",
        "Local creator session required.",
      );
    }
    return Promise.resolve(fixtureAuthentication());
  },
  context,
  reserve: async (context, country, actorUserId) =>
    await rpc("reserve_creator_connect_account", {
      account_key: context.account_key,
      country,
      actor_user_id: actorUserId,
    }),
  persist: async (context, snapshot, verifiedAt) => {
    if (expectedAccount && snapshot.account_id !== expectedAccount) {
      throw Error("A resumed fixture cannot switch creator accounts.");
    }
    await rpc("set_creator_connect_account", {
      affiliate_id: context.affiliate_id,
      platform_account_id: context.platform_account_id,
      livemode: false,
      account_key: context.account_key,
      connect_account_id: snapshot.account_id,
      charges_enabled: snapshot.charges_enabled,
      payouts_enabled: snapshot.payouts_enabled,
      transfers_enabled: snapshot.transfers_active,
      details_submitted: snapshot.details_submitted,
      requirements_due: snapshot.requirements_due,
      disabled_reason: snapshot.disabled_reason,
      verified_at: verifiedAt,
    });
  },
  provider,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
Deno.serve({
  hostname: "127.0.0.1",
  port: 5194,
  onListen: () =>
    console.log(
      "Creator bridge ready; platform identity and test mode verified.",
    ),
}, async (request) => {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ready: true, mode: input.mode });
    }
    if (request.headers.get("authorization") !== `Bearer ${input.token}`) {
      return json({ error: "Local creator session required." }, 401);
    }
    if (url.pathname === "/evidence" && request.method === "GET") {
      const account = await sql(
        `select jsonb_build_object('connectedAccountId',connect_account_id,'status',status,'detailsSubmitted',details_submitted,'payoutsEnabled',payouts_enabled,'transfersEnabled',transfers_enabled,'requirementsDue',requirements_due,'verifiedAt',verified_at) from public.external_creator_accounts where affiliate_id='ac570000-0000-4000-8000-000000000003' and platform_account_id=${
          literal(config.platformAccountId)
        } and not livemode`,
      );
      return json({
        mode: input.mode,
        counts,
        account,
        creationPrefill,
        settlementJobs: await sql(
          "select count(*) from public.external_settlement_jobs",
        ),
        databaseOnlyLocal: true,
        moneyMovementEnabled: false,
        runId: input.runId ?? null,
        resumed: expectedAccount !== null,
        expectedConnectedAccountId: expectedAccount,
        providerTimings,
        requestTimings,
        authentication:
          "synthetic fresh password AMR; real reauthentication and MFA not exercised",
      });
    }
    if (url.pathname !== "/creator-connect" || request.method !== "POST") {
      return json({ error: "Unavailable local operation." }, 404);
    }
    const body = await request.clone().json() as JsonObject;
    if (!["status", "session"].includes(String(body.action))) {
      return json({ error: "Only embedded setup is available." }, 400);
    }
    const started = Date.now();
    const response = await handler(request);
    let expiresAt: number | null = null;
    if (response.ok) {
      if (body.action === "session") {
        counts.successfulSessions++;
        const session = await response.clone().json();
        if (typeof session.account_session?.expires_at === "number") {
          expiresAt = session.account_session.expires_at;
        }
      } else counts.statusChecks++;
    }
    recordTiming(requestTimings, {
      action: body.action,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      status: response.status,
      session_expires_at: expiresAt,
    });
    return response;
  } catch {
    return json({ error: "Local creator acceptance request failed." }, 500);
  }
});

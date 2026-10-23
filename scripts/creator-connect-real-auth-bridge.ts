// Disposable integration adapter only. Authentication uses the deployed handler's
// unmodified Supabase getUser + auth-policy path against a real local GoTrue.
// The SQL adapter substitutes for PostgREST, and Stripe transport is fake.
import { createCreatorConnectHandler } from "../supabase/functions/creator-connect/index.ts";
import { authenticatedClient } from "../supabase/functions/_shared/supabase.ts";
import { ConnectProvider } from "../supabase/functions/creator-connect/provider.ts";
import {
  config,
  FakeStripe,
} from "../supabase/functions/creator-connect/test-support.ts";
import type { CreatorContext } from "../supabase/functions/creator-connect/index.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";

const raw = await new Response(Deno.stdin.readable).text();
const input = JSON.parse(raw) as {
  socket: string;
  port: number;
  authPort: number;
  control: string;
  anonKey: string;
};
if (
  !/^\/(?:private\/)?tmp\/kma-real-auth\.[A-Za-z0-9]+$/.test(input.socket) ||
  ![input.port, input.authPort].every((port) =>
    Number.isInteger(port) && port > 1024 && port < 65536
  )
) {
  throw Error("A disposable local real-auth fixture is required.");
}
const origin = `http://127.0.0.1:${input.port}`;
Deno.env.set("SUPABASE_URL", origin);
Deno.env.set("SUPABASE_ANON_KEY", input.anonKey);
const fake = new FakeStripe();
fake.accounts.clear();
fake.platformId = "acct_fixture";
const binding = {
  ...config,
  origin,
  platformAccountId: "acct_fixture",
  transfersEnabled: false,
};
let clock: number | null = null;
const literal = (value: unknown) =>
  `'${
    String(typeof value === "object" ? JSON.stringify(value) : value)
      .replaceAll("'", "''")
  }'`;
async function sql(
  statement: string,
  role = "service_role",
  claims: unknown = { role: "service_role" },
) {
  const child = new Deno.Command("/opt/homebrew/opt/postgresql@17/bin/psql", {
    args: [
      "-h",
      input.socket,
      "-U",
      Deno.env.get("USER")!,
      "-d",
      "postgres",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `begin;set local role ${role};set local request.jwt.claims=${
        literal(claims)
      };${statement};commit;`,
    ),
  );
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new RequestError(
      403,
      "fixture_database_denied",
      "Local database permission denied.",
    );
  }
  const last = new TextDecoder().decode(output.stdout).trim().split("\n").at(
    -1,
  );
  return last ? JSON.parse(last) : null;
}
const handler = createCreatorConnectHandler({
  bindings: () => new Map([["fixture", binding]]),
  // No authenticate override: real GoTrue verifies the exact bearer token.
  context: async (authorization) => {
    const token = authorization.slice(7);
    const { data, error } = await authenticatedClient(authorization).auth
      .getUser(token);
    if (error || !data.user) {
      throw new RequestError(401, "unauthorized", "Local sign-in required.");
    }
    const claims = JSON.parse(
      atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (claims.sub !== data.user.id) {
      throw Error("Local token subject mismatch.");
    }
    try {
      return await sql(
        "select public.creator_connect_context('acct_fixture',false)",
        "authenticated",
        claims,
      ) as CreatorContext;
    } catch {
      return null;
    }
  },
  reserve: (context, country, actorUserId) =>
    sql(
      `select public.reserve_creator_connect_account(${
        literal({
          account_key: context.account_key,
          country,
          actor_user_id: actorUserId,
        })
      }::jsonb)`,
    ),
  persist: async (context, snapshot) => {
    await sql(`select public.set_creator_connect_account(${
      literal({
        affiliate_id: context.affiliate_id,
        platform_account_id: context.platform_account_id,
        livemode: false,
        account_key: context.account_key,
        connect_account_id: snapshot.account_id,
        charges_enabled: snapshot.charges_enabled,
        payouts_enabled: snapshot.payouts_enabled,
        transfers_enabled: snapshot.transfers_active,
        details_submitted: snapshot.details_submitted,
        disabled_reason: snapshot.disabled_reason,
        requirements_due: snapshot.requirements_due,
        // Only the authentication freshness clock advances in this fixture.
        // Provider verification and database evidence keep real wall time.
        verified_at: new Date().toISOString(),
      })
    }::jsonb)`);
  },
  provider: () => new ConnectProvider(binding, fake.fetch),
  now: () => clock ?? Date.now(),
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
Deno.serve(
  { hostname: "127.0.0.1", port: input.port, onListen() {} },
  async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth/v1/")) {
      const next = new URL(
        url.pathname.slice("/auth/v1".length) + url.search,
        `http://127.0.0.1:${input.authPort}`,
      );
      return fetch(new Request(next, request));
    }
    if (url.pathname === "/functions/v1/creator-connect") {
      return handler(
        request,
      );
    }
    if (request.headers.get("x-local-control") !== input.control) {
      return json({
        error: "Not found",
      }, 404);
    }
    if (url.pathname === "/test/clock" && request.method === "POST") {
      const body = await request.json();
      if (body.offset === 0) clock = null;
      else if (body.offset === 601_000) clock = Date.now() + 601_000;
      else if (
        Number.isSafeInteger(body.now) && body.now >= Date.now() &&
        body.now <= Date.now() + 601_000
      ) clock = body.now;
      else return json({ error: "Invalid local freshness clock" }, 400);
      return json({ okay: true });
    }
    if (url.pathname === "/test/evidence") {
      return json({
        accountCreates: fake.calls.filter((call) =>
          call.path === "accounts" && call.method === "POST"
        ).length,
        accountSessions: fake.calls.filter((call) =>
          call.path === "account_sessions"
        ).length,
        stored: await sql(
          "select jsonb_build_object('accounts',count(*),'connected',count(connect_account_id)) from public.external_creator_accounts",
        ),
      });
    }
    return json({ okay: true });
  },
);

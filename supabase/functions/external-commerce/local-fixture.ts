/** LOCAL TEST ONLY. Actual KMA request handlers + SQL, injected loopback Stripe.
 * Deno permissions must deny all external network access. No real credentials. */
import { createOrderEligibilityHandler } from "../funnel-order-eligibility/index.ts";
import { createFunnelMetricEventHandler } from "../funnel-metric-events/index.ts";
import { createFunnelEventHandler } from "../funnel-events/index.ts";
import { createExternalCommerceHandler } from "./index.ts";
import { type CommerceBinding, verifyCommerceWithStripe } from "./contract.ts";
import { RequestError } from "../_shared/errors.ts";
import type { FunnelKeyBinding } from "../_shared/env.ts";
const socket = Deno.args[0];
if (
  !/^\/(?:private\/)?tmp\/kma-external-commerce-db\.[A-Za-z0-9]+$/.test(
    socket ?? "",
  )
) throw new Error("Only the disposable KMA fixture socket is permitted.");
const key = "speaksix-local";
const binding: CommerceBinding = {
  secret: "speaksix-local-kma-signing-secret-fixture-only",
  productId: "ac570000-0000-4000-8000-000000000001",
  funnelId: "ac570000-0000-4000-8000-000000000002",
  accountId: "acct_marathonlocalfixture",
  livemode: false,
  stripeReadKey: "rk_test_fixture",
};
const literal = (value: unknown) =>
  `'${
    (typeof value === "object" ? JSON.stringify(value) : String(value))
      .replaceAll("'", "''")
  }'`;
async function sql(statement: string) {
  const result = await new Deno.Command(
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    {
      args: [
        "-h",
        socket,
        "-U",
        Deno.env.get("USER") || "user",
        "-d",
        "postgres",
        "-XAtq",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `set role service_role;${statement}`,
      ],
      clearEnv: true,
      env: {
        PGHOST: socket,
        PGDATABASE: "postgres",
      },
      stdout: "piped",
      stderr: "piped",
    },
  ).output();
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    throw new RequestError(
      409,
      "fixture_database_rejected",
      "Local fixture database rejected evidence.",
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}
const authorize = async (
  keyId: string,
  clickId: string,
  product: string,
  funnel: string,
) => {
  await sql(
    `select public.assert_funnel_request_scope(${literal(keyId)},${
      literal(clickId)
    },${literal(product)}::uuid,${literal(funnel)}::uuid)`,
  );
};
const funnel = createFunnelEventHandler({
  bindings: () => new Map([[key, binding]]),
  allowedNames: () =>
    new Set([
      "webinar_registered",
      "marathon_assessed",
      "marathon_pool_joined",
      "marathon_cohort_proposed",
      "marathon_cohort_confirmed",
    ]),
  allowedProperties: () =>
    new Set(["stage", "form_version", "needs_review", "lesson_count"]),
  authorizeScope: authorize,
  ingest: async (input) => {
    const result = JSON.parse(
      await sql(
        `select row_to_json(r) from public.ingest_funnel_event(${
          literal(input)
        }::jsonb) r`,
      ),
    );
    return { eventId: result.event_id, duplicate: result.duplicate };
  },
});
const metrics = createFunnelMetricEventHandler({
  bindings: () =>
    new Map<string, FunnelKeyBinding>([
      [key, binding],
      ["course-local", {
        secret: "course-local-kma-signing-secret-fixture-only",
        productId: "ac570000-0000-4000-8000-000000000041",
        funnelId: "ac570000-0000-4000-8000-000000000042",
      }],
    ]),
  authorize,
  ingest: async (product, funnel, event) =>
    JSON.parse(
      await sql(
        `select public.ingest_funnel_metric_event(${literal(product)}::uuid,${
          literal(funnel)
        }::uuid,${literal(event)}::jsonb)`,
      ),
    ),
});
const eligibility = createOrderEligibilityHandler({
  bindings: () => new Map([[key, binding]]),
  authorize,
  ingest: async (product, funnel, event) =>
    JSON.parse(
      await sql(
        `select public.ingest_external_order_eligibility(${
          literal(product)
        }::uuid,${literal(funnel)}::uuid,${literal(event)}::jsonb)`,
      ),
    ),
});
const stripe: typeof fetch = (url, init) => {
  const upstream = new URL(String(url));
  if (upstream.origin !== "https://api.stripe.com" || init?.method !== "GET") {
    throw new Error("Fixture only permits Stripe reads.");
  }
  return fetch(`http://127.0.0.1:3202${upstream.pathname}${upstream.search}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: "Bearer sk_test_marathon_local_fixture_not_a_real_key",
    },
    redirect: "error",
  });
};
const commerce = createExternalCommerceHandler({
  bindings: () => new Map([[key, binding]]),
  authorize: (k, input, b) =>
    authorize(k, input.click_id, b.productId, b.funnelId),
  verify: (input, b) => verifyCommerceWithStripe(input, b, stripe),
  recordBasis: async (input) => {
    await sql(
      `select public.record_external_commission_basis(${
        literal(input)
      }::jsonb)`,
    );
  },
  ingest: async (evidence) =>
    JSON.parse(
      await sql(
        `select public.ingest_external_commerce(${literal(evidence)}::jsonb)`,
      ),
    ),
});
Deno.serve({ hostname: "127.0.0.1", port: 3203 }, async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/functions/v1/funnel-order-eligibility") {
    return eligibility(request);
  }
  if (path === "/functions/v1/funnel-metric-events") return metrics(request);
  if (path === "/functions/v1/funnel-events") return funnel(request);
  if (path === "/functions/v1/external-commerce") return commerce(request);
  if (path === "/__fixture/status") {
    return Response.json(
      JSON.parse(
        await sql(
          "select jsonb_build_object('eligibilityEvents',(select count(*) from public.external_order_eligibility_events),'metricEvents',(select count(*) from public.funnel_metric_events),'funnelEvents',(select count(*) from public.events where source='first_party'),'orders',(select count(*) from public.external_commerce_orders),'heldOrders',(select count(*) from public.external_commerce_orders where commission_status='held'),'purchases',(select count(*) from public.external_commerce_events where kind='purchase'),'refunds',(select count(*) from public.external_commerce_events where kind='refund'),'netMinor',(select coalesce(sum(case when kind='purchase' then amount_minor else -amount_minor end),0) from public.external_commerce_events))",
        ),
      ),
    );
  }
  return new Response("Local KMA fixture", {
    status: path === "/" ? 200 : 404,
  });
});

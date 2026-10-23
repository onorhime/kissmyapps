import { assertEquals, assertMatch } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  handleStripeWebhook,
  type StripeWebhookDependencies,
} from "./index.ts";

const secret = "whsec_local_unit_test_only";
async function request(
  options: {
    unsigned?: boolean;
    tampered?: boolean;
    stale?: boolean;
    live?: boolean;
    version?: string;
  } = {},
) {
  const timestamp = Math.floor(Date.now() / 1000) - (options.stale ? 1000 : 0);
  const body = JSON.stringify({
    id: "evt_ingress123456",
    type: "invoice.paid",
    api_version: options.version ?? STRIPE_API_VERSION,
    livemode: options.live ?? true,
    data: {
      object: {
        id: "in_ingress123456",
        customer_email: "private@example.invalid",
      },
    },
  });
  const hash = bytesToHex(
    await hmacSha256(secret, new TextEncoder().encode(`${timestamp}.${body}`)),
  );
  return new Request("https://example.invalid/stripe-webhook", {
    method: "POST",
    body: body + (options.tampered ? " " : ""),
    headers: {
      "Content-Type": "application/json",
      ...(options.unsigned
        ? {}
        : { "stripe-signature": `t=${timestamp},v1=${hash}` }),
    },
  });
}
function harness(owned = true, failure = false) {
  let classified = 0, persisted = 0;
  const deps: StripeWebhookDependencies = {
    webhookSecret: () => secret,
    owns: () => {
      classified++;
      if (failure) {
        throw new RequestError(503, "ownership_unavailable", "Retry delivery.");
      }
      return Promise.resolve(owned);
    },
    persist: (event, digest) => {
      persisted++;
      assertMatch(digest, /^[a-f0-9]{64}$/);
      assertEquals(JSON.stringify(event).includes("private@"), false);
      return Promise.resolve({ duplicate: false });
    },
  };
  return { deps, counts: () => ({ classified, persisted }) };
}
Deno.test("webhook: verified unrelated event returns 200 without storage", async () => {
  const h = harness(false);
  const response = await handleStripeWebhook(await request(), h.deps);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ignored, true);
  assertEquals(h.counts(), { classified: 1, persisted: 0 });
});
Deno.test("webhook: owned event persists minimized evidence after classification", async () => {
  const h = harness();
  const response = await handleStripeWebhook(await request(), h.deps);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).received, true);
  assertEquals(h.counts(), { classified: 1, persisted: 1 });
});
Deno.test("webhook: inconclusive ownership retries and never stores", async () => {
  const h = harness(false, true);
  const response = await handleStripeWebhook(await request(), h.deps);
  assertEquals(response.status, 503);
  assertEquals(h.counts(), { classified: 1, persisted: 0 });
});
for (
  const options of [{ unsigned: true }, { tampered: true }, { stale: true }, {
    live: false,
  }, { version: "2025-11-17.clover" }]
) {
  Deno.test(`webhook: rejects ${JSON.stringify(options)} before ownership or persistence`, async () => {
    const h = harness();
    const response = await handleStripeWebhook(await request(options), h.deps);
    assertEquals(response.status, 400);
    assertEquals(h.counts(), { classified: 0, persisted: 0 });
  });
}

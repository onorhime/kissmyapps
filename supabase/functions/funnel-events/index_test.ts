import { assertEquals } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import { createFunnelEventHandler } from "./index.ts";

const encoder = new TextEncoder();
const secret = "a-production-strength-funnel-secret-for-tests";
const productId = "11111111-1111-4111-8111-111111111111";
const funnelId = "22222222-2222-4222-8222-222222222222";
const clickId = "c".repeat(48);

async function signedRequest(body: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = "nonce_abcdefghijklmnop";
  const bytes = encoder.encode(body);
  const prefix = encoder.encode(`${timestamp}.${nonce}.`);
  const canonical = new Uint8Array(prefix.length + bytes.length);
  canonical.set(prefix);
  canonical.set(bytes, prefix.length);
  const signature = bytesToHex(await hmacSha256(secret, canonical));
  return new Request("https://edge.example/functions/v1/funnel-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-key-id": "product-funnel-key",
      "x-kma-nonce": nonce,
      "x-kma-signature": signature,
      "x-kma-timestamp": String(timestamp),
    },
    body,
  });
}

function eventBody(): string {
  return JSON.stringify({
    event_id: "33333333-3333-4333-8333-333333333333",
    event_name: "lead_created",
    click_id: clickId,
    occurred_at: new Date().toISOString(),
    properties: { plan: "monthly" },
  });
}

Deno.test("funnel events authorize the signed key's exact product and funnel before ingestion", async () => {
  const calls: string[][] = [];
  let ingested = 0;
  const handler = createFunnelEventHandler({
    bindings: () =>
      new Map([["product-funnel-key", { secret, productId, funnelId }]]),
    allowedNames: () => new Set(["lead_created"]),
    allowedProperties: () => new Set(["plan"]),
    authorizeScope: (keyId, scopedClick, product, funnel) => {
      calls.push([keyId, scopedClick, product, funnel]);
      return Promise.resolve();
    },
    ingest: () => {
      ingested += 1;
      return Promise.resolve({
        eventId: "44444444-4444-4444-8444-444444444444",
        duplicate: false,
      });
    },
  });

  const response = await handler(await signedRequest(eventBody()));

  assertEquals(response.status, 200);
  assertEquals(calls, [[
    "product-funnel-key",
    clickId,
    productId,
    funnelId,
  ]]);
  assertEquals(ingested, 1);
});

Deno.test("funnel events never ingest when the database rejects key scope", async () => {
  let ingested = 0;
  const handler = createFunnelEventHandler({
    bindings: () =>
      new Map([["product-funnel-key", { secret, productId, funnelId }]]),
    allowedNames: () => new Set(["lead_created"]),
    allowedProperties: () => new Set(["plan"]),
    authorizeScope: () =>
      Promise.reject(
        new RequestError(
          404,
          "click_unavailable",
          "The affiliate click is unavailable.",
        ),
      ),
    ingest: () => {
      ingested += 1;
      return Promise.resolve({
        eventId: "44444444-4444-4444-8444-444444444444",
        duplicate: false,
      });
    },
  });

  const response = await handler(await signedRequest(eventBody()));

  assertEquals(response.status, 404);
  assertEquals(ingested, 0);
});

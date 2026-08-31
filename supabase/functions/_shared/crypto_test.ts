import { assertEquals, assertRejects } from "@std/assert";
import {
  bytesToHex,
  hmacSha256,
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "./crypto.ts";
import { RequestError } from "./errors.ts";

const encoder = new TextEncoder();
const secret = "a-production-strength-secret-that-is-not-real";
const timestamp = 1_788_000_000;
const nonce = "nonce_abcdefghijklmnop";
const body = encoder.encode('{"event_id":"event_server_001"}');

async function signedHeaders(payload = body): Promise<Headers> {
  const prefix = encoder.encode(`${timestamp}.${nonce}.`);
  const canonical = new Uint8Array(prefix.length + payload.length);
  canonical.set(prefix);
  canonical.set(payload, prefix.length);
  const signature = bytesToHex(await hmacSha256(secret, canonical));
  return new Headers({
    "x-kma-key-id": "primary",
    "x-kma-nonce": nonce,
    "x-kma-signature": signature,
    "x-kma-timestamp": String(timestamp),
  });
}

Deno.test("funnel HMAC verifies the exact raw request bytes", async () => {
  const parsed = parseFunnelSignatureHeaders(await signedHeaders());
  await verifyFunnelSignature(
    body,
    parsed,
    new Map([["primary", secret]]),
    timestamp,
  );
  assertEquals(parsed.keyId, "primary");
});

Deno.test("funnel HMAC rejects body changes, unknown keys, and stale requests", async () => {
  const parsed = parseFunnelSignatureHeaders(await signedHeaders());
  await assertRejects(
    () =>
      verifyFunnelSignature(
        encoder.encode('{"event_id":"tampered_event"}'),
        parsed,
        new Map([["primary", secret]]),
        timestamp,
      ),
    RequestError,
  );
  await assertRejects(
    () => verifyFunnelSignature(body, parsed, new Map(), timestamp),
    RequestError,
  );
  await assertRejects(
    () =>
      verifyFunnelSignature(
        body,
        parsed,
        new Map([["primary", secret]]),
        timestamp + 301,
      ),
    RequestError,
  );
});

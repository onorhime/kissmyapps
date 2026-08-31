import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bytesToHex, hmacSha256 } from "./crypto.ts";
import { RequestError } from "./errors.ts";
import {
  parseStripeEvent,
  parseStripeSignatureHeader,
  persistStripeEvent,
  stripeSignedBodySha256,
  SUPPORTED_STRIPE_EVENT_TYPES,
  verifyStripeSignature,
} from "./stripe.ts";
import { STRIPE_API_VERSION } from "./stripe-api.ts";

const encoder = new TextEncoder();
const secret = "whsec_this-is-a-non-production-test-secret";
const timestamp = 1_788_000_000;
const body = encoder.encode(
  JSON.stringify({
    id: "evt_12345678",
    type: "invoice.paid",
    livemode: true,
    api_version: STRIPE_API_VERSION,
    data: { object: { id: "in_123" } },
  }),
);

async function signatureHeader(payload = body): Promise<string> {
  const prefix = encoder.encode(`${timestamp}.`);
  const canonical = new Uint8Array(prefix.length + payload.length);
  canonical.set(prefix);
  canonical.set(payload, prefix.length);
  return `t=${timestamp},v1=${bytesToHex(await hmacSha256(secret, canonical))}`;
}

function eventBytes(
  type: string,
  object: Record<string, unknown>,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    id: "evt_projection123",
    object: "event",
    type,
    livemode: true,
    created: timestamp,
    api_version: STRIPE_API_VERSION,
    account: "acct_not_needed",
    pending_webhooks: 1,
    request: { id: "req_not_needed", idempotency_key: "secret" },
    data: {
      previous_attributes: { customer_email: "previous@example.test" },
      object,
    },
  }));
}

interface PersistenceHarness {
  client: SupabaseClient;
  rpcCalls: Array<{ name: string; input: Record<string, unknown> }>;
}

function persistenceHarness(options: {
  duplicate?: boolean;
  errorCode?: string;
} = {}): PersistenceHarness {
  const rpcCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, input: Record<string, unknown>) {
      rpcCalls.push({ name, input });
      return Promise.resolve(
        options.errorCode
          ? { data: null, error: { code: options.errorCode } }
          : {
            data: {
              provider_event_id: "22222222-2222-4222-8222-222222222222",
              duplicate: options.duplicate ?? false,
            },
            error: null,
          },
      );
    },
  } as unknown as SupabaseClient;

  return { client, rpcCalls };
}

Deno.test("Stripe verifier authenticates raw body and parses production envelope", async () => {
  await verifyStripeSignature(body, await signatureHeader(), secret, timestamp);
  assertEquals(parseStripeEvent(body), {
    id: "evt_12345678",
    type: "invoice.paid",
    livemode: true,
    apiVersion: STRIPE_API_VERSION,
    payload: {
      id: "evt_12345678",
      type: "invoice.paid",
      livemode: true,
      data: { object: { id: "in_123" } },
    },
  });
});

Deno.test("Stripe envelope permits documented legacy null version but rejects an explicit mismatch", () => {
  const legacy = encoder.encode(JSON.stringify({
    id: "evt_legacy123",
    type: "invoice.paid",
    livemode: true,
    api_version: null,
    data: { object: { id: "in_123" } },
  }));
  assertEquals(parseStripeEvent(legacy).apiVersion, null);

  const mismatched = encoder.encode(JSON.stringify({
    id: "evt_mismatch123",
    type: "invoice.paid",
    livemode: true,
    api_version: "2025-08-27.basil",
    data: { object: { id: "in_123" } },
  }));
  const error = assertThrows(
    () => parseStripeEvent(mismatched),
    RequestError,
  );
  assertEquals(error.code, "unsupported_stripe_api_version");
});

Deno.test("supported Stripe events retain only normalization evidence", () => {
  const checkoutMetadata = {
    kma_attempt_id: "11111111-1111-4111-8111-111111111111",
    kma_public_attempt_id: "a".repeat(48),
    kma_offer_id: "22222222-2222-4222-8222-222222222222",
    kma_product_id: "33333333-3333-4333-8333-333333333333",
    kma_acquisition_id: "44444444-4444-4444-8444-444444444444",
    kma_click_id: "55555555-5555-4555-8555-555555555555",
    kma_expected_amount_minor: "1999",
    kma_expected_currency: "USD",
  };
  const fixtures: Array<{
    types: readonly string[];
    object: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      types: [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ],
      object: {
        id: "cs_live_abcdefgh123",
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        amount_total: 1999,
        currency: "usd",
        client_reference_id: "a".repeat(48),
        customer: {
          id: "cus_abcdefgh123",
          name: "Private Customer",
          email: "customer@example.test",
          address: { line1: "Private address" },
        },
        subscription: {
          id: "sub_abcdefgh123",
          customer: { email: "nested@example.test" },
        },
        customer_details: {
          name: "Private Customer",
          email: "customer@example.test",
          address: { line1: "Private address" },
        },
        payment_method_types: ["card"],
        metadata: {
          ...checkoutMetadata,
          customer_email: "metadata@example.test",
        },
      },
      expected: {
        id: "cs_live_abcdefgh123",
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        amount_total: 1999,
        currency: "usd",
        client_reference_id: "a".repeat(48),
        customer: "cus_abcdefgh123",
        subscription: "sub_abcdefgh123",
        metadata: checkoutMetadata,
      },
    },
    {
      types: [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ],
      object: {
        id: "sub_abcdefgh123",
        object: "subscription",
        livemode: true,
        customer: {
          id: "cus_abcdefgh123",
          name: "Private Customer",
          email: "customer@example.test",
        },
        status: "active",
        currency: "usd",
        current_period_start: timestamp,
        current_period_end: timestamp + 2_592_000,
        canceled_at: null,
        metadata: {
          kma_attempt_id: checkoutMetadata.kma_attempt_id,
          customer_email: "metadata@example.test",
        },
        default_payment_method: {
          id: "pm_private",
          billing_details: { email: "billing@example.test" },
        },
      },
      expected: {
        id: "sub_abcdefgh123",
        object: "subscription",
        livemode: true,
        status: "active",
        currency: "usd",
        current_period_start: timestamp,
        current_period_end: timestamp + 2_592_000,
        canceled_at: null,
        customer: "cus_abcdefgh123",
        metadata: { kma_attempt_id: checkoutMetadata.kma_attempt_id },
      },
    },
    {
      types: ["invoice.paid"],
      object: {
        id: "in_abcdefgh123",
        object: "invoice",
        status: "paid",
        paid: true,
        amount_paid: 1999,
        total: 1999,
        total_excluding_tax: 1799,
        currency: "usd",
        customer: {
          id: "cus_abcdefgh123",
          name: "Private Customer",
          email: "customer@example.test",
          address: { line1: "Private address" },
        },
        billing_reason: "subscription_create",
        parent: {
          subscription_details: {
            subscription: {
              id: "sub_abcdefgh123",
              customer: { email: "nested@example.test" },
            },
            metadata: { customer_email: "parent@example.test" },
          },
        },
        status_transitions: {
          finalized_at: timestamp - 10,
          paid_at: timestamp,
        },
        customer_email: "invoice@example.test",
        customer_name: "Private Customer",
        customer_address: { line1: "Private address" },
        payment_settings: { payment_method_types: ["card"] },
      },
      expected: {
        id: "in_abcdefgh123",
        object: "invoice",
        status: "paid",
        paid: true,
        amount_paid: 1999,
        total: 1999,
        total_excluding_tax: 1799,
        currency: "usd",
        billing_reason: "subscription_create",
        customer: "cus_abcdefgh123",
        status_transitions: { paid_at: timestamp },
        parent: {
          subscription_details: { subscription: "sub_abcdefgh123" },
        },
      },
    },
    {
      types: ["refund.created", "refund.updated"],
      object: {
        id: "re_abcdefgh123",
        object: "refund",
        status: "succeeded",
        amount: 500,
        currency: "usd",
        created: timestamp,
        charge: {
          id: "ch_abcdefgh123",
          billing_details: { email: "billing@example.test" },
        },
        destination_details: { card: { reference: "private" } },
      },
      expected: {
        id: "re_abcdefgh123",
        object: "refund",
        status: "succeeded",
        amount: 500,
        currency: "usd",
        created: timestamp,
        charge: "ch_abcdefgh123",
      },
    },
    {
      types: [
        "charge.dispute.created",
        "charge.dispute.updated",
        "charge.dispute.closed",
      ],
      object: {
        id: "dp_abcdefgh123",
        object: "dispute",
        status: "needs_response",
        amount: 1999,
        currency: "usd",
        created: timestamp,
        charge: {
          id: "ch_abcdefgh123",
          billing_details: { email: "billing@example.test" },
        },
        balance_transactions: [{
          id: "txn_abcdefgh123",
          amount: -1999,
          fee: 1500,
          net: -3499,
          currency: "usd",
          created: timestamp,
          description: "Private description",
        }],
        evidence: { customer_email_address: "evidence@example.test" },
        payment_method_details: { card: { last4: "4242" } },
      },
      expected: {
        id: "dp_abcdefgh123",
        object: "dispute",
        status: "needs_response",
        amount: 1999,
        currency: "usd",
        created: timestamp,
        charge: "ch_abcdefgh123",
        balance_transactions: [{
          id: "txn_abcdefgh123",
          amount: -1999,
          fee: 1500,
          net: -3499,
          currency: "usd",
          created: timestamp,
        }],
      },
    },
  ];

  const coveredTypes: string[] = [];
  for (const fixture of fixtures) {
    for (const type of fixture.types) {
      coveredTypes.push(type);
      const event = parseStripeEvent(eventBytes(type, fixture.object));
      assertEquals(event.payload, {
        id: "evt_projection123",
        type,
        livemode: true,
        created: timestamp,
        data: { object: fixture.expected },
      });
      const persistedPayload = JSON.stringify(event.payload);
      for (
        const forbidden of [
          "@example.test",
          "Private Customer",
          "Private address",
          "payment_method",
          "last4",
        ]
      ) {
        assertEquals(persistedPayload.includes(forbidden), false);
      }
    }
  }
  assertEquals(coveredTypes, [...SUPPORTED_STRIPE_EVENT_TYPES]);
});

Deno.test("unsupported Stripe event types are rejected before persistence", () => {
  const error = assertThrows(
    () =>
      parseStripeEvent(eventBytes("payment_intent.succeeded", {
        id: "pi_abcdefgh123",
        object: "payment_intent",
      })),
    RequestError,
  );
  assertEquals(error.status, 400);
  assertEquals(error.code, "unsupported_event_type");
});

Deno.test("Stripe verifier accepts any valid v1 during secret rotation", async () => {
  const valid = await signatureHeader();
  const signature = valid.split("v1=")[1];
  await verifyStripeSignature(
    body,
    `t=${timestamp},v1=${"0".repeat(64)},v1=${signature}`,
    secret,
    timestamp,
  );
});

Deno.test("Stripe verifier rejects tampering, stale timestamps, and malformed events", async () => {
  const validHeader = await signatureHeader();
  await assertRejects(
    () =>
      verifyStripeSignature(
        encoder.encode("{}"),
        validHeader,
        secret,
        timestamp,
      ),
    RequestError,
  );
  await assertRejects(
    async () =>
      verifyStripeSignature(
        body,
        await signatureHeader(),
        secret,
        timestamp + 301,
      ),
    RequestError,
  );
  assertThrows(() => parseStripeSignatureHeader("v1=bad"), RequestError);
  assertThrows(() => parseStripeEvent(encoder.encode("{}")), RequestError);
});

Deno.test("Stripe signed-body digest covers the exact raw bytes", async () => {
  assertEquals(
    await stripeSignedBodySha256(encoder.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    await stripeSignedBodySha256(encoder.encode("abc\n")),
    "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
  );
});

Deno.test("new Stripe persistence stores the digest with the minimized payload", async () => {
  const harness = persistenceHarness();
  const event = parseStripeEvent(body);
  const digest = await stripeSignedBodySha256(body);
  assertEquals(
    await persistStripeEvent(harness.client, event, digest),
    { duplicate: false },
  );
  assertEquals(harness.rpcCalls, [{
    name: "persist_stripe_provider_event",
    input: {
      p_input: {
        event_id: event.id,
        event_type: event.type,
        payload: event.payload,
        signed_body_sha256: digest,
      },
    },
  }]);
});

Deno.test("a Stripe retry with the same signed-body digest is duplicate-safe", async () => {
  const digest = "a".repeat(64);
  const harness = persistenceHarness({ duplicate: true });
  assertEquals(
    await persistStripeEvent(harness.client, parseStripeEvent(body), digest),
    { duplicate: true },
  );
  assertEquals(harness.rpcCalls.length, 1);
});

Deno.test("a reused Stripe event ID with a different digest is rejected", async () => {
  const harness = persistenceHarness({ errorCode: "23505" });
  const error = await assertRejects(
    () =>
      persistStripeEvent(
        harness.client,
        parseStripeEvent(body),
        "a".repeat(64),
      ),
    RequestError,
  );
  assertEquals(error.status, 409);
  assertEquals(error.code, "event_id_conflict");
  assertEquals(harness.rpcCalls.length, 1);
});

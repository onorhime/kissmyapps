// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  CONNECT_PAYMENT_EVENT_TYPES,
  type ConnectPaymentsLogEntry,
  type ConnectPaymentsWebhookDependencies,
  createConnectPaymentsWebhook,
  handleConnectPaymentsWebhook,
  type PaymentReceipt,
  type ReceiptOutcome,
} from "./index.ts";

type Json = Record<string, unknown>;
const NOW = Date.parse("2026-11-13T12:00:00Z"), TIME = Math.floor(NOW / 1000);
const SECRET = "whsec_connectpaymentsfixture";
const PLATFORM = "acct_KMAPlatform";
const MERCHANT = "acct_MerchantA";
const URL = "https://functions.example/connect-payments-webhook";

// Everything a receipt must never keep. Each fixture object below carries some.
const SENSITIVE = [
  "Jane Private",
  "buyer@private.example",
  "+15555550100",
  "1 Hidden Lane",
  "90210",
  "4242",
  "fp_CardFingerprint",
  "cus_PrivateCustomer",
  "pm_PrivateMethod",
  "vip note about Jane",
  "ba_PrivateBank",
];
const person = {
  name: "Jane Private",
  email: "buyer@private.example",
  phone: "+15555550100",
  address: { line1: "1 Hidden Lane", postal_code: "90210", country: "US" },
};
const OBJECTS: Record<string, Json> = {
  "checkout.session": {
    id: "cs_live_a1B2c3",
    object: "checkout.session",
    amount_subtotal: 5000,
    amount_total: 4900,
    currency: "usd",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_3LiveIntent1",
    client_reference_id: null,
    customer: "cus_PrivateCustomer",
    customer_email: person.email,
    customer_details: person,
    metadata: { internal: "vip note about Jane" },
  },
  payment_intent: {
    id: "pi_3LiveIntent1",
    object: "payment_intent",
    amount: 5000,
    amount_received: 4900,
    currency: "usd",
    customer: "cus_PrivateCustomer",
    payment_method: "pm_PrivateMethod",
    receipt_email: person.email,
    shipping: person,
    latest_charge: "ch_3LiveCharge1",
    metadata: { internal: "vip note about Jane" },
  },
  invoice: {
    id: "in_1LiveInvoice1",
    object: "invoice",
    amount_due: 3000,
    amount_paid: 2900,
    currency: "eur",
    customer: "cus_PrivateCustomer",
    customer_email: person.email,
    customer_name: person.name,
    customer_address: person.address,
    metadata: {},
  },
  charge: {
    id: "ch_3LiveCharge1",
    object: "charge",
    amount: 4900,
    amount_refunded: 1500,
    currency: "usd",
    payment_intent: "pi_3LiveIntent1",
    billing_details: person,
    receipt_email: person.email,
    payment_method: "pm_PrivateMethod",
    payment_method_details: {
      card: { brand: "visa", last4: "4242", fingerprint: "fp_CardFingerprint" },
    },
    metadata: {},
  },
  refund: {
    id: "re_3LiveRefund1",
    object: "refund",
    amount: 1500,
    currency: "usd",
    charge: "ch_3LiveCharge1",
    payment_intent: "pi_3LiveIntent1",
    status: "succeeded",
    destination_details: { card: { reference: "ba_PrivateBank" } },
    metadata: {},
  },
  dispute: {
    id: "dp_1LiveDispute1",
    object: "dispute",
    amount: 4900,
    currency: "gbp",
    charge: "ch_3LiveCharge1",
    payment_intent: "pi_3LiveIntent1",
    status: "needs_response",
    evidence: {
      customer_name: person.name,
      customer_email_address: person.email,
      billing_address: "1 Hidden Lane, 90210",
    },
    metadata: {},
  },
};
const OBJECT_OF: Record<string, string> = {
  "checkout.session.completed": "checkout.session",
  "checkout.session.async_payment_succeeded": "checkout.session",
  "payment_intent.succeeded": "payment_intent",
  "invoice.paid": "invoice",
  "charge.refunded": "charge",
  "refund.created": "refund",
  "refund.updated": "refund",
  "charge.dispute.created": "dispute",
  "charge.dispute.closed": "dispute",
};

function event(
  type = "checkout.session.completed",
  object: Json = {},
  envelope: Json = {},
): Json {
  return {
    id: "evt_1LiveEvent0001",
    object: "event",
    api_version: "2026-02-25.clover",
    type,
    created: TIME - 5,
    livemode: true,
    account: MERCHANT,
    pending_webhooks: 1,
    request: { id: "req_PrivateRequest", idempotency_key: null },
    data: { object: { ...OBJECTS[OBJECT_OF[type] ?? "charge"], ...object } },
    ...envelope,
  };
}

async function signature(body: string, secret = SECRET, time = TIME) {
  const mac = bytesToHex(
    await hmacSha256(secret, new TextEncoder().encode(`${time}.${body}`)),
  );
  return `t=${time},v1=${mac}`;
}

async function request(
  payload: Json | string,
  options: {
    secret?: string;
    time?: number;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request(URL, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Stripe-Signature": await signature(body, options.secret, options.time),
      ...options.headers,
    },
    body: options.method === "GET" ? undefined : body,
  });
}

function fixture(
  overrides: Partial<ConnectPaymentsWebhookDependencies> = {},
  outcome: ReceiptOutcome = { matched: true, duplicate: false },
) {
  const saved: PaymentReceipt[] = [], logs: ConnectPaymentsLogEntry[] = [];
  const handler = createConnectPaymentsWebhook({
    enabled: () => true,
    webhookSecret: () => SECRET,
    platformAccountId: () => PLATFORM,
    now: () => NOW,
    log: (entry) => logs.push(entry),
    persist: async (receipt) => {
      saved.push(receipt);
      return outcome;
    },
    ...overrides,
  });
  return { handler, saved, logs };
}

async function sha256(text: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );
}

Deno.test("a disabled webhook answers 503 and stores nothing, even for a valid event", async () => {
  let consulted = false;
  const f = fixture({
    enabled: () => false,
    webhookSecret: () => {
      consulted = true;
      return SECRET;
    },
  });
  for (const type of CONNECT_PAYMENT_EVENT_TYPES) {
    const response = await f.handler(await request(event(type)));
    assertEquals(response.status, 503);
    assertEquals(
      (await response.json()).error,
      "connect_payments_webhook_disabled",
    );
  }
  assertEquals(f.saved.length, 0);
  assertEquals(consulted, false);
});

Deno.test("only the exact value true in the environment turns the webhook on", async () => {
  const name = "CONNECT_PAYMENTS_WEBHOOK_ENABLED";
  const previous = Deno.env.get(name);
  const saved: PaymentReceipt[] = [];
  // The shipped switch, with everything after it faked.
  const handler = createConnectPaymentsWebhook({
    webhookSecret: () => SECRET,
    platformAccountId: () => PLATFORM,
    now: () => NOW,
    log: () => {},
    persist: async (receipt) => {
      saved.push(receipt);
      return { matched: true, duplicate: false };
    },
  });
  // The exported handler logs to the console; keep the test output quiet.
  const consoleLog = console.log;
  console.log = () => {};
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "yes"]) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
      const response = await handler(await request(event()));
      assertEquals(response.status, 503, String(value));
      assertEquals(
        (await response.json()).error,
        "connect_payments_webhook_disabled",
      );
      // So does the exported handler that Deno.serve runs.
      assertEquals(
        (await handleConnectPaymentsWebhook(await request(event()))).status,
        503,
      );
    }
    assertEquals(saved.length, 0);
    Deno.env.set(name, "true");
    assertEquals((await handler(await request(event()))).status, 200);
    assertEquals(saved.length, 1);
  } finally {
    console.log = consoleLog;
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("an enabled webhook without a signing secret or platform account fails closed", async () => {
  for (
    const overrides of [
      { webhookSecret: () => undefined },
      { webhookSecret: () => "" },
      { webhookSecret: () => "sk_live_notawebhooksecret" },
      { platformAccountId: () => undefined },
      { platformAccountId: () => "not-an-account" },
    ]
  ) {
    const f = fixture(overrides);
    const response = await f.handler(await request(event()));
    assertEquals(response.status, 503);
    assertEquals((await response.json()).error, "configuration_error");
    assertEquals(f.saved.length, 0);
  }
});

Deno.test("a bad or missing signature answers 400 before anything is read or stored", async () => {
  const f = fixture();
  const body = JSON.stringify(event());
  const cases: Request[] = [
    await request(event(), { secret: "whsec_someoneelsessecret" }),
    // Signed body differs from the delivered body.
    new Request(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": await signature(body),
      },
      body: body.replace("4900", "1"),
    }),
    new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    await request(event(), { headers: { "Stripe-Signature": "" } }),
    await request(event(), { headers: { "Stripe-Signature": "t=1,v1=zz" } }),
    await request(event(), {
      headers: { "Stripe-Signature": `t=${TIME},v1=${"0".repeat(64)}` },
    }),
    // An unsigned scheme is never accepted.
    await request(event(), {
      headers: {
        "Stripe-Signature": (await signature(body)).replace("v1=", "v0="),
      },
    }),
  ];
  for (const bad of cases) {
    const response = await f.handler(bad);
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "invalid_signature");
  }
  assertEquals(f.saved.length, 0);
});

Deno.test("a stale or future-dated signature is rejected", async () => {
  const f = fixture();
  for (const time of [TIME - 301, TIME - 86400, TIME + 301]) {
    const response = await f.handler(await request(event(), { time }));
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "expired_signature");
  }
  // Inside Stripe's five minute tolerance.
  assertEquals(
    (await f.handler(await request(event(), { time: TIME - 299 }))).status,
    200,
  );
  assertEquals(f.saved.length, 1);
});

Deno.test("browsers, other methods, other content types and oversized bodies are refused", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(await request(event(), { method: "GET" }))).status,
    405,
  );
  assertEquals(
    (await f.handler(
      await request(event(), { headers: { "Content-Type": "text/plain" } }),
    )).status,
    415,
  );
  assertEquals(
    (await f.handler(
      await request(event(), {
        headers: { Origin: "https://merchant.kissmyapps.dev" },
      }),
    )).status,
    403,
  );
  const huge = event("checkout.session.completed", {
    metadata: { filler: "x".repeat(512 * 1024) },
  });
  assertEquals((await f.handler(await request(huge))).status, 413);
  assertEquals(f.saved.length, 0);
});

Deno.test("an event of the platform account itself, or without an account, is rejected", async () => {
  const f = fixture();
  const withoutAccount = event();
  delete withoutAccount.account;
  for (
    const e of [
      event("checkout.session.completed", {}, { account: PLATFORM }),
      withoutAccount,
      event("checkout.session.completed", {}, { account: null }),
      event("checkout.session.completed", {}, { account: "" }),
      event("checkout.session.completed", {}, { account: "acct_bad id" }),
      event("checkout.session.completed", {}, { account: { id: MERCHANT } }),
    ]
  ) {
    const response = await f.handler(await request(e));
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "event_scope_mismatch");
  }
  assertEquals(f.saved.length, 0);
});

Deno.test("receipts are recorded under the configured platform account, never one named by the event", async () => {
  const f = fixture({ platformAccountId: () => "acct_ConfiguredPlatform" });
  const e = event("checkout.session.completed", {}, {
    platform_account_id: "acct_Forged",
    data: {
      object: {
        ...OBJECTS["checkout.session"],
        platform_account_id: "acct_Forged",
      },
    },
  });
  assertEquals((await f.handler(await request(e))).status, 200);
  assertEquals(f.saved[0].platform_account_id, "acct_ConfiguredPlatform");
  assertEquals(f.saved[0].account_id, MERCHANT);
});

Deno.test("a test mode event is acknowledged and ignored", async () => {
  const f = fixture();
  for (const type of CONNECT_PAYMENT_EVENT_TYPES) {
    const response = await f.handler(
      await request(event(type, {}, { livemode: false })),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals([body.received, body.ignored], [true, true]);
  }
  assertEquals(f.saved.length, 0);
  assertEquals(f.logs.every((l) => l.outcome === "ignored_not_live"), true);
});

Deno.test("each handled event type keeps exactly its identifiers, amount and currency", async () => {
  const base = {
    platform_account_id: PLATFORM,
    livemode: true,
    account_id: MERCHANT,
    event_id: "evt_1LiveEvent0001",
    event_created: TIME - 5,
    kma_click: null,
    tag_source: null,
  };
  const expected: Record<string, Json> = {
    "checkout.session.completed": {
      object_id: "cs_live_a1B2c3",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 4900,
      currency: "USD",
    },
    "checkout.session.async_payment_succeeded": {
      object_id: "cs_live_a1B2c3",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 4900,
      currency: "USD",
    },
    "payment_intent.succeeded": {
      object_id: "pi_3LiveIntent1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 4900,
      currency: "USD",
    },
    "invoice.paid": {
      object_id: "in_1LiveInvoice1",
      payment_intent_id: null,
      amount_minor: 2900,
      currency: "EUR",
    },
    "charge.refunded": {
      object_id: "ch_3LiveCharge1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 1500,
      currency: "USD",
    },
    "refund.created": {
      object_id: "re_3LiveRefund1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 1500,
      currency: "USD",
    },
    "refund.updated": {
      object_id: "re_3LiveRefund1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 1500,
      currency: "USD",
    },
    "charge.dispute.created": {
      object_id: "dp_1LiveDispute1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 4900,
      currency: "GBP",
    },
    "charge.dispute.closed": {
      object_id: "dp_1LiveDispute1",
      payment_intent_id: "pi_3LiveIntent1",
      amount_minor: 4900,
      currency: "GBP",
    },
  };
  assertEquals(
    [...CONNECT_PAYMENT_EVENT_TYPES].sort(),
    Object.keys(expected).sort(),
  );
  for (const type of CONNECT_PAYMENT_EVENT_TYPES) {
    const f = fixture();
    const body = JSON.stringify(event(type));
    const response = await f.handler(await request(body));
    assertEquals(response.status, 200, type);
    const answer = await response.json();
    assertEquals([answer.received, answer.duplicate], [true, false], type);
    // Exact equality: a receipt has these keys and no others.
    assertEquals(f.saved, [{
      ...base,
      event_type: type,
      ...expected[type],
      payload_sha256: await sha256(body),
    } as unknown as PaymentReceipt], type);
    assertEquals(f.logs.map((l) => [l.outcome, l.event_id, l.event_type]), [
      ["recorded", "evt_1LiveEvent0001", type],
    ]);
  }
});

Deno.test("amounts, currencies and payment intents that are absent or malformed are stored as null", async () => {
  const cases: [string, Json, Partial<PaymentReceipt>][] = [
    ["checkout.session.completed", { amount_total: null }, {
      amount_minor: null,
    }],
    ["checkout.session.completed", { amount_total: "4900" }, {
      amount_minor: null,
    }],
    ["checkout.session.completed", { amount_total: 49.5 }, {
      amount_minor: null,
    }],
    ["checkout.session.completed", { amount_total: -1 }, {
      amount_minor: null,
    }],
    ["checkout.session.completed", { amount_total: 0 }, { amount_minor: 0 }],
    ["checkout.session.completed", { currency: null }, { currency: null }],
    ["checkout.session.completed", { currency: "dollars" }, {
      currency: null,
    }],
    // Subscription mode: the session has no PaymentIntent.
    ["checkout.session.completed", { payment_intent: null }, {
      payment_intent_id: null,
    }],
    ["checkout.session.completed", { payment_intent: "ch_notanintent" }, {
      payment_intent_id: null,
    }],
    // An expanded PaymentIntent collapses to its id; its customer detail is dropped.
    ["charge.refunded", {
      payment_intent: { id: "pi_3Expanded", receipt_email: person.email },
    }, { payment_intent_id: "pi_3Expanded" }],
    // An older API version still names the PaymentIntent on the invoice.
    ["invoice.paid", { payment_intent: "pi_3InvoiceIntent" }, {
      payment_intent_id: "pi_3InvoiceIntent",
    }],
    // The amount is the type's own field, never a neighbouring one.
    ["payment_intent.succeeded", { amount: 9999, amount_received: 100 }, {
      amount_minor: 100,
    }],
    ["charge.refunded", { amount: 9999, amount_refunded: 250 }, {
      amount_minor: 250,
    }],
    ["invoice.paid", { amount_due: 9999, amount_paid: 0 }, { amount_minor: 0 }],
  ];
  for (const [type, object, want] of cases) {
    const f = fixture();
    assertEquals(
      (await f.handler(await request(event(type, object)))).status,
      200,
    );
    for (const [key, value] of Object.entries(want)) {
      assertEquals(
        f.saved[0][key as keyof PaymentReceipt],
        value,
        `${type} ${JSON.stringify(object)}`,
      );
    }
  }
});

Deno.test("an unknown event type answers 200 without storing", async () => {
  const f = fixture();
  for (
    const type of [
      "charge.succeeded",
      "customer.created",
      "charge.dispute.updated",
      "account.updated",
      "payment_intent.payment_failed",
      "checkout.session.expired",
      "constructor",
      "valueof",
    ]
  ) {
    const response = await f.handler(await request(event(type)));
    assertEquals(response.status, 200, type);
    assertEquals((await response.json()).ignored, true, type);
  }
  assertEquals(f.saved.length, 0);
  assertEquals(f.logs.every((l) => l.outcome === "ignored_event_type"), true);
});

Deno.test("an account that is not connected answers 200 so Stripe stops retrying", async () => {
  const f = fixture({}, { matched: false, duplicate: false });
  const response = await f.handler(await request(event()));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals([body.received, body.ignored], [true, true]);
  assertEquals(f.saved.length, 1);
  assertEquals(f.logs.map((l) => l.outcome), ["ignored_unmatched_account"]);
});

Deno.test("a duplicate delivery answers 200", async () => {
  const seen = new Set<string>();
  const f = fixture({
    persist: async (receipt) => {
      const duplicate = seen.has(receipt.event_id);
      seen.add(receipt.event_id);
      return { matched: true, duplicate };
    },
  });
  const first = await f.handler(await request(event()));
  const second = await f.handler(await request(event()));
  assertEquals([first.status, second.status], [200, 200]);
  assertEquals((await first.json()).duplicate, false);
  assertEquals((await second.json()).duplicate, true);
  assertEquals(f.logs.map((l) => l.outcome), ["recorded", "duplicate"]);
});

Deno.test("the creator tag comes from metadata first, then a kma_ client reference", async () => {
  const cases: [string, Json, string | null, string | null][] = [
    [
      "checkout.session.completed",
      {
        metadata: { kma_click: "kma_Click-0001" },
        client_reference_id: "kma_reference_2",
      },
      "kma_Click-0001",
      "metadata",
    ],
    [
      "checkout.session.completed",
      {
        metadata: {},
        client_reference_id: "kma_reference_2",
      },
      "kma_reference_2",
      "client_reference_id",
    ],
    [
      "checkout.session.async_payment_succeeded",
      {
        metadata: null,
        client_reference_id: "kma_reference_2",
      },
      "kma_reference_2",
      "client_reference_id",
    ],
    // A client reference that is not ours is somebody's order number: not kept.
    [
      "checkout.session.completed",
      {
        metadata: {},
        client_reference_id: "order_12345678",
      },
      null,
      null,
    ],
    [
      "checkout.session.completed",
      {
        metadata: {},
        client_reference_id: "KMA_reference_2",
      },
      null,
      null,
    ],
    // An unusable metadata value does not hide a usable client reference.
    [
      "checkout.session.completed",
      {
        metadata: { kma_click: "no" },
        client_reference_id: "kma_reference_2",
      },
      "kma_reference_2",
      "client_reference_id",
    ],
    // Any tag in metadata is kept as sent, whatever its prefix.
    [
      "payment_intent.succeeded",
      {
        metadata: { kma_click: "AbC-123_xyz" },
      },
      "AbC-123_xyz",
      "metadata",
    ],
    [
      "invoice.paid",
      {
        metadata: { kma_click: "kma_invoice_tag" },
      },
      "kma_invoice_tag",
      "metadata",
    ],
    [
      "charge.refunded",
      {
        metadata: { kma_click: "kma_charge_tag" },
      },
      "kma_charge_tag",
      "metadata",
    ],
    [
      "refund.created",
      {
        metadata: { kma_click: "kma_refund_tag" },
      },
      "kma_refund_tag",
      "metadata",
    ],
    [
      "charge.dispute.created",
      {
        metadata: { kma_click: "kma_dispute_tag" },
      },
      "kma_dispute_tag",
      "metadata",
    ],
    // Only Checkout Sessions have a client reference.
    [
      "payment_intent.succeeded",
      {
        metadata: {},
        client_reference_id: "kma_reference_2",
      },
      null,
      null,
    ],
    [
      "checkout.session.completed",
      {
        metadata: { kma_click: "x".repeat(200) },
      },
      "x".repeat(200),
      "metadata",
    ],
  ];
  for (const [type, object, tag, source] of cases) {
    const f = fixture();
    assertEquals(
      (await f.handler(await request(event(type, object)))).status,
      200,
    );
    assertEquals(
      [f.saved[0].kma_click, f.saved[0].tag_source],
      [tag, source],
      `${type} ${JSON.stringify(object).slice(0, 120)}`,
    );
  }
});

Deno.test("an invalid tag is stored as null and the receipt is still recorded", async () => {
  const invalid: unknown[] = [
    "short",
    "kma_123",
    "x".repeat(201),
    "kma click with spaces",
    "kma_<script>alert(1)</script>",
    "kma_tag\n",
    "kma_täg_unicode",
    "buyer@private.example",
    "",
    12345678,
    true,
    null,
    ["kma_Click-0001"],
    { value: "kma_Click-0001" },
  ];
  for (const value of invalid) {
    for (
      const object of [
        { metadata: { kma_click: value }, client_reference_id: null },
        { metadata: {}, client_reference_id: value },
        ...(typeof value === "string"
          ? [{ metadata: {}, client_reference_id: `kma_${value}!` }]
          : []),
      ]
    ) {
      const f = fixture();
      const response = await f.handler(
        await request(event("checkout.session.completed", object)),
      );
      assertEquals(response.status, 200);
      assertEquals(f.saved.length, 1);
      assertEquals(
        [f.saved[0].kma_click, f.saved[0].tag_source],
        [null, null],
        JSON.stringify(object).slice(0, 120),
      );
    }
  }
  // A tag inherited from Object.prototype is not a tag.
  const f = fixture();
  const body = JSON.stringify(event()).replace(
    '"metadata":{',
    '"metadata":{"__proto__":{"kma_click":"kma_Click-0001"},',
  );
  assertEquals((await f.handler(await request(body))).status, 200);
  assertEquals(f.saved[0].kma_click, null);
});

Deno.test("a database failure answers 5xx so Stripe retries", async () => {
  const failures: [() => Promise<ReceiptOutcome>, number, string][] = [
    [
      async () => {
        throw new DatabaseBoundaryError("57014");
      },
      503,
      "database_boundary_error",
    ],
    [
      async () => {
        throw new DatabaseBoundaryError("22023");
      },
      503,
      "database_boundary_error",
    ],
    [
      async () => {
        throw new DatabaseBoundaryError();
      },
      503,
      "database_boundary_error",
    ],
    [
      async () => {
        throw new TypeError("connection reset while sending acct_MerchantA");
      },
      500,
      "internal_error",
    ],
    // An answer that does not say what happened is not a success.
    [
      async () => null as unknown as ReceiptOutcome,
      503,
      "database_boundary_error",
    ],
    [
      async () => ({ matched: true }) as ReceiptOutcome,
      503,
      "database_boundary_error",
    ],
    [
      async () =>
        ({ matched: "true", duplicate: 0 }) as unknown as ReceiptOutcome,
      503,
      "database_boundary_error",
    ],
  ];
  for (const [persist, status, code] of failures) {
    const f = fixture({ persist });
    const response = await f.handler(await request(event()));
    assertEquals(response.status, status);
    const body = await response.json();
    assertEquals(body.error, code);
    assertEquals(body.received, undefined);
    assertEquals(f.logs.length, 1);
    assertEquals(f.logs[0].level, "error");
    assertEquals(f.logs[0].outcome, code);
  }
});

Deno.test("the same event id with a different signed body answers 409, not success", async () => {
  const f = fixture({
    persist: async () => {
      throw new DatabaseBoundaryError("23505");
    },
  });
  const response = await f.handler(await request(event()));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "event_id_conflict");
  assertEquals(f.logs[0].outcome, "event_id_conflict");
});

Deno.test("a signed body that is not a well-formed event of its type answers 400", async () => {
  const f = fixture();
  const noData = event();
  delete noData.data;
  const bodies: (Json | string)[] = [
    "not json",
    "[]",
    "null",
    '"evt_1LiveEvent0001"',
    "",
    event("checkout.session.completed", {}, { id: "not_an_event" }),
    event("checkout.session.completed", {}, { id: 42 }),
    event("checkout.session.completed", {}, { type: 42 }),
    event("checkout.session.completed", {}, { livemode: "true" }),
    event("checkout.session.completed", {}, { created: "yesterday" }),
    event("checkout.session.completed", {}, { created: 0 }),
    event("checkout.session.completed", {}, { created: TIME + 301 }),
    event("checkout.session.completed", {}, { created: TIME + 0.5 }),
    noData,
    event("checkout.session.completed", {}, { data: { object: null } }),
    event("checkout.session.completed", {}, { data: { object: [] } }),
    // The object is not the kind its event type promises.
    event("checkout.session.completed", { object: "charge" }),
    event("payment_intent.succeeded", { object: "checkout.session" }),
    event("charge.dispute.created", { object: "charge" }),
    event("refund.created", { id: null }),
    event("refund.created", { id: "re bad id" }),
    event("invoice.paid", { id: { id: "in_1" } }),
  ];
  for (const body of bodies) {
    const response = await f.handler(await request(body));
    assertEquals(
      response.status,
      400,
      typeof body === "string" ? body : JSON.stringify(body).slice(0, 200),
    );
    assertEquals((await response.json()).error, "invalid_event");
  }
  assertEquals(f.saved.length, 0);
});

Deno.test("nothing sensitive reaches receipts, logs or responses", async () => {
  const written: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      written.push(
        args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(
          " ",
        ),
      );
    };
  }
  const responses: string[] = [], receipts: PaymentReceipt[] = [];
  try {
    // The shipped logger (console) with fake persistence; every outcome once.
    const outcomes: (ReceiptOutcome | Error)[] = [
      { matched: true, duplicate: false },
      { matched: true, duplicate: true },
      { matched: false, duplicate: false },
      new DatabaseBoundaryError("57014"),
      new DatabaseBoundaryError("23505"),
      new Error(`could not store ${JSON.stringify(person)}`),
    ];
    for (const outcome of outcomes) {
      const handler = createConnectPaymentsWebhook({
        enabled: () => true,
        webhookSecret: () => SECRET,
        platformAccountId: () => PLATFORM,
        now: () => NOW,
        persist: async (receipt) => {
          receipts.push(receipt);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
      const requests = [
        ...await Promise.all(
          CONNECT_PAYMENT_EVENT_TYPES.map((type) =>
            request(event(type, {
              // A tag that is really personal data is never kept as a tag.
              metadata: {
                kma_click: person.email,
                internal: "vip note about Jane",
              },
              client_reference_id: "Jane Private",
            }))
          ),
        ),
        await request(event("customer.created", person)),
        await request(event("charge.refunded", {}, { livemode: false })),
        await request(event("charge.refunded", {}, { account: PLATFORM })),
        await request(event("charge.refunded", { object: "refund" })),
        await request(event(), { secret: "whsec_someoneelsessecret" }),
        await request(event(), { time: TIME - 4000 }),
        await request(`{"name":"Jane Private","card":"4242"`),
      ];
      for (const r of requests) {
        const signatureHeader = r.headers.get("stripe-signature") ?? "";
        // A fixed request id: a random one could contain a marker by chance.
        r.headers.set("X-Request-ID", "request-fixture-id");
        const response = await handler(r);
        const text = await response.text();
        responses.push(text + JSON.stringify([...response.headers]));
        assert(!text.includes(signatureHeader.split("v1=")[1]));
      }
    }
  } finally {
    methods.forEach((m, i) => console[m] = original[i]);
  }
  assert(receipts.length >= CONNECT_PAYMENT_EVENT_TYPES.length * 6);
  assert(
    written.length >= responses.length,
    "every request leaves one log line",
  );
  const everything = [
    ...written,
    ...responses,
    // The body hash is hexadecimal and says nothing about the body.
    ...receipts.map((r) => JSON.stringify({ ...r, payload_sha256: "" })),
  ].join("\n");
  for (const secret of [...SENSITIVE, SECRET, "req_PrivateRequest"]) {
    assert(!everything.includes(secret), `leaked ${secret}`);
  }
  // Logs carry the event id and type, an outcome and a request id; nothing else.
  const allowed = new Set([
    "level",
    "worker",
    "outcome",
    "request_id",
    "event_id",
    "event_type",
    "database_code",
  ]);
  for (const line of written) {
    const entry = JSON.parse(line);
    assertEquals(entry.worker, "connect-payments-webhook");
    assertEquals(Object.keys(entry).filter((k) => !allowed.has(k)), []);
    assert(!line.includes(MERCHANT) && !line.includes(PLATFORM));
  }
  // Receipts carry exactly the thirteen columns of the table's input.
  for (const receipt of receipts) {
    assertEquals(Object.keys(receipt).sort(), [
      "account_id",
      "amount_minor",
      "currency",
      "event_created",
      "event_id",
      "event_type",
      "kma_click",
      "livemode",
      "object_id",
      "payload_sha256",
      "payment_intent_id",
      "platform_account_id",
      "tag_source",
    ]);
    assertEquals([receipt.kma_click, receipt.tag_source], [null, null]);
  }
});

Deno.test("an unverified request cannot put its own text in the logs", async () => {
  const f = fixture();
  const forged = event("checkout.session.completed", {}, {
    id: "evt_Forged0001",
    type: "forged.type",
  });
  await f.handler(
    await request(forged, { secret: "whsec_someoneelsessecret" }),
  );
  await f.handler(
    await request(
      event("checkout.session.completed", {}, {
        id: "evt_<script>",
        type: "Not A Type\n",
      }),
    ),
  );
  assertEquals(f.logs.length, 2);
  for (const entry of f.logs) {
    assertEquals([entry.event_id, entry.event_type], [undefined, undefined]);
  }
});

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createAgreementNotifyHandler } from "./index.ts";
import {
  DeliveryFailure,
  type EmailJob,
  type Envelope,
  type NotifyDependencies,
  sendViaResend,
} from "../_shared/agreement-email-worker.ts";
import { renderEmail } from "../_shared/agreement-email.ts";

const secret = "test-worker-secret-".repeat(3);
const job: EmailJob = {
  id: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  type: "signing_request",
  to: "owner@example.test",
  envelope: null,
  context: {
    partnerName: "Partner",
    productName: "Product",
    agreementVersion: 1,
  },
};
function request(body: unknown = {}, token = secret) {
  return new Request("https://edge.example.test/agreement-notify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-internal-secret": token,
    },
    body: JSON.stringify(body),
  });
}
function fixture(overrides: Partial<NotifyDependencies> = {}) {
  const calls: string[] = [];
  const outcomes: unknown[] = [];
  const handler = createAgreementNotifyHandler({
    cleanup: () => Promise.resolve(0),
    secret: () => secret,
    from: () => "KissMyApps <partners@example.test>",
    claim: () => {
      calls.push("claim");
      return Promise.resolve([job]);
    },
    seal: (_job, envelope) => {
      calls.push("seal");
      return Promise.resolve(envelope);
    },
    send: () => {
      calls.push("send");
      return Promise.resolve("provider-id");
    },
    finish: (_job, outcome) => {
      calls.push("finish");
      outcomes.push(outcome);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { handler, calls, outcomes };
}
Deno.test("notification worker rejects authentication before claiming", async () => {
  const f = fixture();
  assertEquals((await f.handler(request({}, "wrong"))).status, 401);
  assertEquals(f.calls, []);
});
Deno.test("caller cannot fabricate milestone, document, or recipient", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(
      request({ type: "agreement_fully_signed", document_id: job.id }),
    )).status,
    400,
  );
  assertEquals(f.calls, []);
});
Deno.test("durable envelope is stored before delivery and receipt", async () => {
  const f = fixture();
  const response = await f.handler(request());
  assertEquals(response.status, 200);
  assertEquals(f.calls, ["claim", "seal", "send", "finish"]);
  assertEquals(f.outcomes, [{ providerId: "provider-id" }]);
});
Deno.test("retries use the previously sealed envelope unchanged", async () => {
  const frozen: Envelope = {
    from: "old@example.test",
    to: job.to,
    subject: "old",
    html: "<p>old</p>",
  };
  const f = fixture({
    claim: () => Promise.resolve([{ ...job, envelope: frozen }]),
    seal: () => {
      throw new Error("must not reseal");
    },
    send: (_id, envelope) => {
      assertEquals(envelope, frozen);
      return Promise.resolve("same-id");
    },
  });
  assertEquals((await f.handler(request())).status, 200);
});
Deno.test("temporary failure records a bounded retry, permanent failure does not", async () => {
  for (const retryable of [true, false]) {
    const f = fixture({
      send: () => {
        throw new DeliveryFailure(
          "provider_http_" + (retryable ? 429 : 422),
          retryable,
        );
      },
    });
    assertEquals((await f.handler(request())).status, 200);
    assertEquals(f.outcomes, [{
      error: "provider_http_" + (retryable ? 429 : 422),
      retryable,
    }]);
  }
});
Deno.test("successful send with failed acknowledgement is not recorded as a new failure", async () => {
  let finishCalls = 0;
  const f = fixture({
    finish: () => {
      finishCalls++;
      throw new Error("db unavailable");
    },
  });
  assertEquals((await f.handler(request())).status, 500);
  assertEquals(finishCalls, 1);
});
Deno.test("HTML stored names are escaped in the rendered message", () => {
  const rendered = renderEmail({ type: "signing_request" }, {
    partnerName: '<a href="evil">name</a>',
    productName: "<img src=x>",
    agreementVersion: 1,
    partnerEmails: [job.to],
    adminEmails: [],
  });
  assertEquals(rendered.html.includes("<img src=x>"), false);
  assertEquals(rendered.html.includes('<a href="evil">'), false);
  assertStringIncludes(rendered.html, "&lt;img src=x&gt;");
});
Deno.test("Resend receives a stable key and exact body with an abort deadline", async () => {
  const envelope = {
    from: "from@example.test",
    to: job.to,
    subject: "hello",
    html: "hi",
  };
  const fetcher: typeof fetch = (_url, init) => {
    assertEquals(
      new Headers(init?.headers).get("Idempotency-Key"),
      "agreement-email/" + job.id,
    );
    assertEquals(init?.body, JSON.stringify(envelope));
    assertEquals(init?.signal instanceof AbortSignal, true);
    return Promise.resolve(Response.json({ id: "receipt-id" }));
  };
  assertEquals(
    await sendViaResend("fake-key", job.id, envelope, fetcher),
    "receipt-id",
  );
  await assertRejects(
    () =>
      sendViaResend(
        "fake-key",
        job.id,
        envelope,
        () => Promise.resolve(new Response("", { status: 429 })),
      ),
    DeliveryFailure,
  );
});

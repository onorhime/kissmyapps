import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  AlertDeliveryError,
  createProcessingAlerts,
  type Dependencies,
  type Job,
  parseJobs,
  renderAlert,
  sendAlert,
} from "./index.ts";
const id = "10000000-0000-4000-8000-000000000001";
const job: Job = {
  id,
  claimToken: "10000000-0000-4000-8000-000000000002",
  kind: "failure",
  to: "operator@example.com",
  from: "KissMyApps <partners@send.kissmyapps.dev>",
  reasons: ["scheduler_paused"],
  observedAt: "2026-09-07T12:00:00Z",
  envelope: null,
};
const request = (body: unknown = {}, secret = "test-alert-secret") =>
  new Request("https://example.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kma-alert-secret": secret,
    },
    body: JSON.stringify(body),
  });
function fixture(overrides: Partial<Dependencies> = {}) {
  const calls: {
    send: unknown[];
    finish: unknown[];
    claim: number;
    seal: number;
  } = { send: [], finish: [], claim: 0, seal: 0 };
  const handler = createProcessingAlerts({
    secret: () => "test-alert-secret",
    claim: () => {
      calls.claim++;
      return Promise.resolve([job]);
    },
    seal: (_j, m) => {
      calls.seal++;
      return Promise.resolve(m);
    },
    send: (i, m) => {
      calls.send.push({ i, m });
      return Promise.resolve(id);
    },
    finish: (j, o) => {
      calls.finish.push({ id: j.id, ...o });
      return Promise.resolve();
    },
    ...overrides,
  });
  return { handler, calls };
}
Deno.test("alerts reject unauthenticated and arbitrary recipient requests before claiming", async () => {
  const { handler, calls } = fixture();
  assertEquals((await handler(request({}, "wrong"))).status, 401);
  assertEquals(
    (await handler(request({ to: "wrong@example.com" }))).status,
    400,
  );
  assertEquals(calls.claim, 0);
  assertEquals(calls.send.length, 0);
});
Deno.test("alerts send only the server-owned envelope and report acceptance not delivery", async () => {
  const { handler, calls } = fixture();
  const r = await handler(request());
  assertEquals(r.status, 200);
  assertEquals((await r.json()).accepted, 1);
  assertEquals(calls.seal, 1);
  assertEquals(calls.send.length, 1);
  assertEquals(calls.finish, [{ id, providerId: id }]);
});
Deno.test("alerts reuse frozen envelopes across retries and releases", async () => {
  const frozen = { ...renderAlert(job), subject: "Previously frozen title" };
  const { handler, calls } = fixture({
    claim: () => Promise.resolve([{ ...job, envelope: frozen }]),
  });
  await handler(request());
  assertEquals(calls.seal, 0);
  assertEquals(calls.send, [{ i: id, m: frozen }]);
});
Deno.test("provider failures persist a bounded retry code without raw response or a second send", async () => {
  const { handler, calls } = fixture({
    send: () =>
      Promise.reject(new AlertDeliveryError("provider_http_503", true)),
  });
  assertEquals((await handler(request())).status, 200);
  assertEquals(calls.finish, [{
    id,
    error: "provider_http_503",
    retryable: true,
  }]);
});
Deno.test("acknowledgement failure leaves durable lease rather than resending", async () => {
  const { handler, calls } = fixture({
    finish: () => Promise.reject(Error("private")),
  });
  assertEquals((await handler(request())).status, 500);
  assertEquals(calls.send.length, 1);
});
Deno.test("failed seal never sends an unpersisted envelope", async () => {
  const { handler, calls } = fixture({
    seal: () => Promise.reject(Error("private")),
  });
  await handler(request());
  assertEquals(calls.send.length, 0);
  assertEquals(calls.finish, [{
    id,
    error: "envelope_unavailable",
    retryable: true,
  }]);
});
Deno.test("empty observations send no mail", async () => {
  const { handler, calls } = fixture({ claim: () => Promise.resolve([]) });
  assertEquals((await (await handler(request())).json()).accepted, 0);
  assertEquals(calls.send.length, 0);
});
Deno.test("job parser fails closed on destinations, unknown reasons and invalid envelopes", () => {
  assertEquals(parseJobs([job]), [job]);
  for (
    const v of [
      { ...job, to: "x@example.com\nBcc:bad" },
      { ...job, reasons: ["raw_secret"] },
      { ...job, envelope: { ...renderAlert(job), to: "another@example.com" } },
      { ...job, claimToken: null },
    ]
  ) assertThrows(() => parseJobs([v]));
  assertThrows(() => parseJobs([job, job]));
});
Deno.test("test and recovery copy do not fabricate failure, settlement or recovery actions", () => {
  assertEquals(
    renderAlert({ ...job, kind: "test", reasons: [] }).html.includes(
      "No payment failure or recovery was simulated",
    ),
    true,
  );
  assertEquals(
    renderAlert({ ...job, kind: "recovery", reasons: [] }).html.includes(
      "not payment settlement",
    ),
    true,
  );
  assertEquals(renderAlert(job).html.includes("automatically restart"), true);
});
Deno.test("Resend uses stable isolated idempotency key and verified receipt", async () => {
  const messages: string[] = [];
  const fetcher: typeof fetch = (_url, options) => {
    assertEquals(
      new Headers(options?.headers).get("Idempotency-Key"),
      `processing-alert/${id}`,
    );
    messages.push(String(options?.body));
    return Promise.resolve(Response.json({ id }));
  };
  assertEquals(await sendAlert("test-key", id, renderAlert(job), fetcher), id);
  await sendAlert("test-key", id, renderAlert(job), fetcher);
  assertEquals(messages[0], messages[1]);
});
Deno.test("Resend errors are fixed codes, never its untrusted body", async () => {
  for (const status of [401, 409, 429, 500]) {
    try {
      await sendAlert(
        "test",
        id,
        renderAlert(job),
        () => Promise.resolve(new Response("private token", { status })),
      );
      throw Error("must reject");
    } catch (e) {
      assertEquals(e instanceof AlertDeliveryError, true);
      assertEquals((e as AlertDeliveryError).code, `provider_http_${status}`);
    }
  }
  await assertRejects(
    () =>
      sendAlert(
        "test",
        id,
        renderAlert(job),
        () => Promise.resolve(Response.json({ id: "not-a-receipt" })),
      ),
    AlertDeliveryError,
  );
});

Deno.test("managed checkout failure joins existing bounded operational alerts without new recipient or sending", () => {
  const managed = { ...job, reasons: ["managed_checkout_issue"] };
  const parsed = parseJobs([managed]);
  assertEquals(parsed[0].to, job.to);
  assertEquals(
    renderAlert(parsed[0]).html.includes(
      "Managed checkout delivery or reconciliation needs attention",
    ),
    true,
  );
});

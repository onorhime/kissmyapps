import { assertEquals, assertFalse } from "@std/assert";
import {
  createDispatchHandler,
  type DispatchDependencies,
  type DispatchDiagnostic,
} from "./index.ts";

const secret = "scheduler-test-credential-not-production-12345";
const run = "12345678-1234-4234-8234-123456789012";
const zero = { claimed: 0, processed: 0, retried: 0, failed: 0, deferred: 0 };

function request(
  body: unknown = { run_id: run, worker: "stripe-worker" },
  credential = secret,
) {
  return new Request("https://example.invalid/processing-dispatch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kma-scheduler-secret": credential,
    },
    body: JSON.stringify(body),
  });
}

for (const worker of ["stripe-worker", "commercial-worker", "metrics-worker"]) {
  Deno.test(`dispatch runs only the issued ${worker} and strips upstream data`, async () => {
    Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
    const calls: string[] = [];
    const handler = createDispatchHandler({
      begin(id, selected) {
        assertEquals(id, run);
        calls.push(`begin:${selected}`);
        return Promise.resolve(true);
      },
      invoke(selected) {
        calls.push(`invoke:${selected}`);
        return Promise.resolve(Response.json({
          ...zero,
          worker,
          status: "processed",
          secret: "never-forward-me",
        }, { headers: { "Set-Cookie": "private" } }));
      },
    });
    const response = await handler(request({ run_id: run, worker }));
    assertEquals(response.status, 200);
    assertEquals(calls, [`begin:${worker}`, `invoke:${worker}`]);
    assertEquals(response.headers.get("set-cookie"), null);
    const body = await response.json();
    assertEquals(body.run_id, run);
    assertEquals(body.worker, worker);
    assertFalse("secret" in body);
  });
}

Deno.test("unauthorized, arbitrary, oversized and duplicate dispatch never invoke workers", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  let began = 0;
  let invoked = 0;
  const handler = createDispatchHandler({
    begin() {
      began++;
      return Promise.resolve(false);
    },
    invoke() {
      invoked++;
      return Promise.resolve(Response.json({}));
    },
  });
  assertEquals((await handler(request(undefined, "bad"))).status, 401);
  for (
    const body of [
      null,
      [],
      {},
      { run_id: run, worker: "reconciliation-worker" },
      { run_id: run, worker: "https://evil.invalid" },
      { run_id: run, worker: "stripe-worker", extra: true },
      { run_id: "invalid", worker: "stripe-worker" },
      { padding: "x".repeat(600) },
    ]
  ) assertEquals((await handler(request(body))).status, 400);
  assertEquals(began, 0);
  assertEquals((await handler(request())).status, 409);
  assertEquals(began, 1);
  assertEquals(invoked, 0);
});

Deno.test("transport, HTTP, malformed and inconsistent worker responses fail closed", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  const base = { ...zero, worker: "stripe-worker", status: "processed" };
  const cases: DispatchDependencies["invoke"][] = [
    () => Promise.reject(new Error("private upstream error")),
    () => Promise.resolve(new Response("private", { status: 401 })),
    () => Promise.resolve(new Response("not-json")),
    () => Promise.resolve(Response.json({ ...base, worker: "metrics-worker" })),
    () => Promise.resolve(Response.json({ ...base, claimed: 1 })),
    () => Promise.resolve(Response.json({ ...base, failed: -1 })),
    () => Promise.resolve(Response.json({ ...base, claimed: "0" })),
    () => Promise.resolve(Response.json({ ...base, deferred: undefined })),
  ];
  for (const invoke of cases) {
    const response = await createDispatchHandler({
      begin: () => Promise.resolve(true),
      invoke,
    })(request());
    assertEquals(response.status >= 500, true);
    assertFalse((await response.text()).includes("private"));
  }
});

Deno.test("degraded batches keep their bounded counters for scheduler health", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  const response = await createDispatchHandler({
    begin: () => Promise.resolve(true),
    invoke: () =>
      Promise.resolve(Response.json({
        status: "processed",
        worker: "stripe-worker",
        claimed: 8,
        processed: 3,
        retried: 2,
        failed: 1,
        deferred: 2,
      })),
  })(request());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).deferred, 2);
});

Deno.test("HTTP failure retains only fixed diagnostic metadata and never retries", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  const records: DispatchDiagnostic[] = [];
  let invoked = 0;
  const response = await createDispatchHandler({
    begin: () => Promise.resolve(true),
    invoke: (worker, id) => {
      invoked++;
      assertEquals(id, run);
      assertEquals(worker, "stripe-worker");
      return Promise.resolve(
        new Response("private provider body", { status: 502 }),
      );
    },
    recordDiagnostic: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  })(request());
  assertEquals(response.status, 503);
  assertEquals(invoked, 1);
  assertEquals(records.length, 1);
  assertEquals(records[0].code, "worker_http_failure");
  assertEquals(records[0].upstream_http_status, 502);
  assertEquals(Object.keys(records[0]).sort(), [
    "code",
    "duration_ms",
    "run_id",
    "upstream_http_status",
    "worker",
  ]);
  assertFalse(JSON.stringify(records).includes("private"));
  assertFalse((await response.text()).includes("private"));
});

Deno.test("transport and invalid response are distinct; diagnostic failure does not hide either", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  for (const transport of [true, false]) {
    let recorded = 0;
    const response = await createDispatchHandler({
      begin: () => Promise.resolve(true),
      invoke: () =>
        transport
          ? Promise.reject(Error("never log credential"))
          : Promise.resolve(new Response("not json")),
      recordDiagnostic: (record) => {
        recorded++;
        assertEquals(
          record.code,
          transport ? "worker_transport_failure" : "worker_response_invalid",
        );
        assertEquals(record.upstream_http_status, transport ? null : 200);
        return Promise.reject(Error("private database detail"));
      },
    })(request());
    assertEquals(recorded, 1);
    assertEquals(response.status >= 500, true);
    assertFalse((await response.text()).includes("private"));
  }
});

Deno.test("oversized worker stream is cancelled before buffering an unbounded body", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  let cancelled = false;
  const response = await createDispatchHandler({
    begin: () => Promise.resolve(true),
    invoke: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4097));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
  })(request());
  assertEquals(response.status, 503);
  assertEquals(cancelled, true);
});

Deno.test("authentication rejection and successful batches do not create failure diagnostics", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", secret);
  let recorded = 0;
  const handler = createDispatchHandler({
    begin: () => Promise.resolve(true),
    invoke: () =>
      Promise.resolve(
        Response.json({
          ...zero,
          worker: "stripe-worker",
          status: "processed",
        }),
      ),
    recordDiagnostic: () => {
      recorded++;
      return Promise.resolve();
    },
  });
  assertEquals((await handler(request(undefined, "wrong"))).status, 401);
  assertEquals((await handler(request())).status, 200);
  assertEquals(recorded, 0);
});

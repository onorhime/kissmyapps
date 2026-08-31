import { assertEquals } from "@std/assert";
import { createMetricsWorkerHandler, type MetricClaim } from "./index.ts";

const secret = "metrics-worker-test-secret-000000000000000";
const claim: MetricClaim = {
  refreshId: "10000000-0000-4000-8000-000000000002",
  claimToken: "30000000-0000-4000-8000-000000000002",
  attemptCount: 1,
};

Deno.test("metrics worker refreshes durable claimed dates", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  let processed = 0;
  const handler = createMetricsWorkerHandler({
    claim: () => Promise.resolve([claim]),
    process: () => {
      processed += 1;
      return Promise.resolve();
    },
    fail: () => Promise.reject(new Error("unexpected failure path")),
  });
  const response = await handler(
    new Request("https://worker.example.test", {
      method: "POST",
      headers: { "x-kma-worker-secret": secret },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(processed, 1);
});

Deno.test("metrics worker retries unexpected processing failures", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  let retried = false;
  const handler = createMetricsWorkerHandler({
    claim: () => Promise.resolve([claim]),
    process: () => Promise.reject(new Error("dependency unavailable")),
    fail: (_claim, code, terminal) => {
      retried = code === "metric_dependency_unavailable" && !terminal;
      return Promise.resolve();
    },
  });
  const response = await handler(
    new Request("https://worker.example.test", {
      method: "POST",
      headers: { "x-kma-worker-secret": secret },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(retried, true);
});

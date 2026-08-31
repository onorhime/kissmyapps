import { assertEquals } from "@std/assert";
import {
  type CommercialClaim,
  createCommercialWorkerHandler,
} from "./index.ts";

const secret = "commercial-worker-test-secret-000000000000";
const claim: CommercialClaim = {
  processingId: "10000000-0000-4000-8000-000000000001",
  sourceKind: "transaction",
  sourceId: "20000000-0000-4000-8000-000000000001",
  claimToken: "30000000-0000-4000-8000-000000000001",
  attemptCount: 1,
};

Deno.test("commercial worker authenticates and processes claimed facts", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  let processed = 0;
  const handler = createCommercialWorkerHandler({
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
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(processed, 1);
  assertEquals(body.external_transfer_enabled, false);
});

Deno.test("commercial worker rejects an invalid shared secret", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  const handler = createCommercialWorkerHandler({
    claim: () => Promise.resolve([]),
    process: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  });
  const response = await handler(
    new Request("https://worker.example.test", {
      method: "POST",
      headers: {
        "x-kma-worker-secret": "wrong-secret-wrong-secret-wrong-secret",
      },
    }),
  );
  assertEquals(response.status, 401);
});

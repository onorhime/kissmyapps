import { assertEquals } from "@std/assert";
import {
  createReconciliationWorkerHandler,
  type ReconciliationClaim,
} from "./index.ts";

const secret = "reconciliation-worker-test-secret-000000000";
const claim: ReconciliationClaim = {
  reconciliationRunId: "10000000-0000-4000-8000-000000000003",
  claimToken: "30000000-0000-4000-8000-000000000003",
  attemptCount: 1,
};

Deno.test("reconciliation worker processes evidence-backed claims only through RPCs", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  let processed = 0;
  const handler = createReconciliationWorkerHandler({
    claim: () => Promise.resolve([claim]),
    process: () => {
      processed += 1;
      return Promise.resolve("passed");
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

Deno.test("reconciliation worker rejects GET requests", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  const handler = createReconciliationWorkerHandler({
    claim: () => Promise.resolve([]),
    process: () => Promise.resolve("passed"),
    fail: () => Promise.resolve(),
  });
  const response = await handler(
    new Request("https://worker.example.test", {
      method: "GET",
      headers: { "x-kma-worker-secret": secret },
    }),
  );
  assertEquals(response.status, 405);
});

Deno.test("reconciliation worker emits a redacted diagnostic for a business failure", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", secret);
  const diagnostics: Array<Readonly<Record<string, unknown>>> = [];
  const handler = createReconciliationWorkerHandler({
    claim: () => Promise.resolve([claim]),
    process: () => Promise.resolve("failed"),
    fail: () => Promise.reject(new Error("unexpected retry path")),
    diagnostic: (entry) => diagnostics.push(entry),
  });
  const response = await handler(
    new Request("https://worker.example.test", {
      method: "POST",
      headers: { "x-kma-worker-secret": secret },
    }),
  );
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.processed, 1);
  assertEquals(body.business_failed, 1);
  assertEquals(diagnostics, [{
    level: "error",
    worker: "reconciliation-worker",
    outcome: "business_reconciliation_failed",
    reconciliation_run_id: claim.reconciliationRunId,
    attempt_count: claim.attemptCount,
    request_id: diagnostics[0].request_id,
  }]);
  assertEquals(typeof diagnostics[0].request_id, "string");
  assertEquals(JSON.stringify(diagnostics).includes("claim_token"), false);
  assertEquals(JSON.stringify(diagnostics).includes(secret), false);
});

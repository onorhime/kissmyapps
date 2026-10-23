import { assertEquals, assertRejects } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanDocumentObjects } from "./document-cleanup.ts";

const job = {
  id: "10000000-0000-4000-8000-000000000001",
  claimToken: "20000000-0000-4000-8000-000000000001",
  filePath: "30000000-0000-4000-8000-000000000001/agreements/unused.pdf",
};
function fixture(
  jobs: unknown = [job],
  deletionFails = false,
  acknowledgementFails = false,
) {
  const calls: unknown[] = [];
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return Promise.resolve(
        name === "claim_document_cleanup_jobs" ? { data: jobs, error: null } : {
          data: null,
          error: acknowledgementFails ? { message: "unavailable" } : null,
        },
      );
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          calls.push({ bucket, paths });
          return Promise.resolve({
            data: [],
            error: deletionFails ? { message: "unavailable" } : null,
          });
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
Deno.test("document cleanup removes only the exact claimed path and acknowledges its token", async () => {
  const f = fixture();
  assertEquals(await cleanDocumentObjects(f.client), 1);
  assertEquals(f.calls, [
    { name: "claim_document_cleanup_jobs", args: undefined },
    { bucket: "affiliate-private-documents", paths: [job.filePath] },
    {
      name: "finish_document_cleanup_job",
      args: { p_id: job.id, p_claim_token: job.claimToken, p_success: true },
    },
  ]);
});
Deno.test("cleanup failure is recorded as retryable without reporting deletion success", async () => {
  const f = fixture([job], true);
  assertEquals(await cleanDocumentObjects(f.client), 0);
  assertEquals(f.calls.at(-1), {
    name: "finish_document_cleanup_job",
    args: { p_id: job.id, p_claim_token: job.claimToken, p_success: false },
  });
});
Deno.test("malformed or broad cleanup claims fail before Storage is called", async () => {
  for (
    const jobs of [
      [{ ...job, filePath: "/" }],
      [{ ...job, filePath: job.filePath + "/../signed.pdf" }],
      [job, job, job, job],
      null,
    ]
  ) {
    const f = fixture(jobs);
    await assertRejects(() => cleanDocumentObjects(f.client));
    assertEquals(f.calls.length, 1);
  }
});
Deno.test("cleanup acknowledgement failure leaves the durable lease for recovery", async () => {
  const f = fixture([job], false, true);
  await assertRejects(() => cleanDocumentObjects(f.client));
  assertEquals(f.calls.length, 3);
});

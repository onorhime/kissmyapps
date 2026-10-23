import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseBoundaryError } from "./errors.ts";
import { isPlainObject } from "./validation.ts";

// The database only leases unreferenced, exact object identities. Recording a
// new document rejects these persistent path tombstones before attachment.
export async function cleanDocumentObjects(
  client: SupabaseClient,
): Promise<number> {
  const claimed = await client.rpc("claim_document_cleanup_jobs");
  if (
    claimed.error || !Array.isArray(claimed.data) || claimed.data.length > 3
  ) throw new DatabaseBoundaryError();
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const jobs = claimed.data.map((job) => {
    if (
      !isPlainObject(job) || typeof job.id !== "string" ||
      !uuid.test(job.id) || typeof job.claimToken !== "string" ||
      !uuid.test(job.claimToken) ||
      typeof job.filePath !== "string" ||
      !uuid.test(job.filePath.slice(0, 36)) || job.filePath[36] !== "/" ||
      job.filePath.length < 38 || job.filePath.length > 1024 ||
      job.filePath.includes("..") || job.filePath.includes("//")
    ) {
      throw new DatabaseBoundaryError();
    }
    return { id: job.id, claimToken: job.claimToken, filePath: job.filePath };
  });
  let removed = 0;
  for (const job of jobs) {
    let success = false;
    try {
      const result = await client.storage.from("affiliate-private-documents")
        .remove([job.filePath]);
      success = !result.error;
    } catch { /* Leave a retryable, scoped job; never log paths or bodies. */ }
    const done = await client.rpc("finish_document_cleanup_job", {
      p_id: job.id,
      p_claim_token: job.claimToken,
      p_success: success,
    });
    if (done.error) throw new DatabaseBoundaryError();
    if (success) removed++;
  }
  return removed;
}

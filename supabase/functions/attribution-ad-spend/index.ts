import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { type Account, readSpend } from "./providers.ts";
type Job = Account & {
  project_id: string;
  lease_id: string;
  from_day: string;
  through_day: string;
};
export async function handler(request: Request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const scheduled = request.headers.has("x-kma-scheduler-secret");
  const expected = Deno.env.get(
    scheduled ? "AD_SPEND_SCHEDULER_SECRET" : "INTERNAL_WORKER_SECRET",
  ) ?? "";
  const received = request.headers.get(
    scheduled ? "x-kma-scheduler-secret" : "x-kma-worker-secret",
  ) ?? "";
  if (
    request.headers.has("origin") || expected.length < 32 ||
    !constantTimeEqualStrings(received, expected)
  ) return new Response(null, { status: 401 });
  if (Deno.env.get("AD_SPEND_ENABLED") !== "true") {
    return Response.json({ enabled: false });
  }
  const db = serviceClient(12000);
  const { data, error } = await db.rpc("ad_spend_claim");
  if (error) return Response.json({ error: "claim_failed" }, { status: 503 });
  let synced = 0, failed = 0;
  await Promise.all((data as Job[]).map(async (job) => {
    let rows = null, failure = null;
    try {
      rows = await readSpend(
        job,
        job.from_day,
        job.through_day,
        Deno.env.get("META_MARKETING_API_VERSION") ?? "v23.0",
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      failure = [
          "currency_mismatch",
          "authorization_failed",
          "provider_rejected",
          "meta_version_required",
          "report_too_large",
          "invalid_report",
        ].includes(message)
        ? message
        : "provider_unavailable";
    }
    const result = await db.rpc("ad_spend_complete", {
      p_project: job.project_id,
      p_provider: job.provider,
      p_lease: job.lease_id,
      p_rows: rows,
      p_error: failure,
    });
    if (failure || result.error) failed++;
    else synced++;
  }));
  return Response.json({ synced, failed }, { status: failed ? 502 : 200 });
}
if (import.meta.main) Deno.serve(handler);

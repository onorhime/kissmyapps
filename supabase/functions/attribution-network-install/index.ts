import { sha256TextHex } from "../_shared/crypto.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

export function networkReport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    o.attribution_consent !== true ||
    !["meta", "tiktok"].includes(o.network as string) ||
    !["ios", "android"].includes(o.platform as string)
  ) return null;
  for (const field of ["report_id", "anonymous_id", "session_id"]) {
    if (
      typeof o[field] !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(o[field])
    ) return null;
  }
  if (
    typeof o.campaign !== "string" || !o.campaign.trim() ||
    o.campaign.length > 200
  ) return null;
  return {
    network: o.network,
    platform: o.platform,
    report_id: o.report_id,
    anonymous_id: o.anonymous_id,
    session_id: o.session_id,
    campaign: o.campaign.trim(),
  };
}
export async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const key = req.headers.get("authorization")?.match(
    /^Bearer (kma_sk_(?:live|test)_[a-zA-Z0-9_-]{16,120})$/,
  )?.[1];
  if (!key) return jsonResponse(401, { error: "project_server_key_required" });
  try {
    const report = networkReport(await readJsonBody(req, 8192));
    if (!report) {
      return jsonResponse(422, { error: "invalid_or_unconsented_report" });
    }
    const { data, error } = await serviceClient().rpc(
      "network_install_record",
      {
        p_key_hash: await sha256TextHex(key),
        p_report: report,
      },
    );
    if (error) {
      return jsonResponse(error.code === "42501" ? 403 : 503, {
        error: error.code === "42501"
          ? "project_unavailable"
          : "storage_unavailable",
      });
    }
    const conflict = data === "awaiting_install" ||
      (data === "conflicting_receipt" || data === "ambiguous_install");
    return jsonResponse(conflict ? 409 : 200, { status: data });
  } catch (error) {
    return errorResponse(error, requestId(req));
  }
}
if (import.meta.main) Deno.serve(handler);

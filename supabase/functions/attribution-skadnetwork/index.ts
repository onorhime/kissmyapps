import { sha256TextHex } from "../_shared/crypto.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyPostback } from "./verify.ts";
export async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const key = req.headers.get("authorization")?.match(
    /^Bearer (kma_sk_(?:live|test)_[a-zA-Z0-9_-]{16,120})$/i,
  )?.[1];
  if (!key) return jsonResponse(401, { error: "project_server_key_required" });
  try {
    const postback = await verifyPostback(await readJsonBody(req, 8192));
    if (!postback) {
      return jsonResponse(422, { error: "invalid_or_unsupported_postback" });
    }
    const hash = await sha256TextHex(key);
    const { data, error } = await serviceClient().rpc("skan_record_postback", {
      p_key_hash: hash,
      p_postback: postback,
    });
    if (error) {
      return jsonResponse(error.code === "42501" ? 403 : 503, {
        error: error.code === "42501"
          ? "project_or_app_mismatch"
          : "postback_storage_unavailable",
      });
    }
    return jsonResponse(200, { status: data });
  } catch (error) {
    return errorResponse(error, requestId(req));
  }
}
if (import.meta.main) Deno.serve(handler);

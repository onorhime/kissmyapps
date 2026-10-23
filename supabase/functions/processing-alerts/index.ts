import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredSecret } from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";

const reasons: Record<string, string> = {
  managed_checkout_issue:
    "Managed checkout delivery or reconciliation needs attention. Inspect its schedule, callback queue and recent run history.",
  scheduler_paused:
    "Processing is paused. Inspect the worker before approving recovery.",
  heartbeat_stale:
    "The scheduler heartbeat is missing or over three minutes old.",
  cycle_stale: "A full processing cycle has not completed within ten minutes.",
  recent_worker_issue:
    "A worker reported a failure, retry or deferred job within the last hour.",
  jobs_failed: "Some processing jobs exhausted their retries.",
  leases_expired:
    "Some worker leases expired; inspect execution before recovery.",
  jobs_stalled: "Unfinished jobs have been waiting for over ten minutes.",
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Envelope {
  from: string;
  to: string;
  subject: string;
  html: string;
}
export interface Job {
  id: string;
  claimToken: string;
  kind: "failure" | "recovery" | "test";
  to: string;
  from: string;
  reasons: string[];
  observedAt: string;
  envelope: Envelope | null;
}
function envelope(v: unknown): Envelope {
  if (
    !isPlainObject(v) || Object.keys(v).length !== 4 ||
    !["from", "to", "subject", "html"].every((k) => typeof v[k] === "string") ||
    JSON.stringify(v).length > 32768
  ) throw new DatabaseBoundaryError();
  return v as unknown as Envelope;
}
export function parseJobs(value: unknown): Job[] {
  if (!Array.isArray(value) || value.length > 1) {
    throw new DatabaseBoundaryError();
  }
  return value.map((v) => {
    if (
      !isPlainObject(v) || typeof v.id !== "string" || !uuid.test(v.id) ||
      typeof v.claimToken !== "string" || !uuid.test(v.claimToken) ||
      !["failure", "recovery", "test"].includes(String(v.kind)) ||
      typeof v.to !== "string" || v.to.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.to) ||
      typeof v.from !== "string" || v.from.length > 300 ||
      /[\r\n]/.test(v.from) ||
      !Array.isArray(v.reasons) || v.reasons.length > 8 || v.reasons.some((r) =>
        typeof r !== "string" || !Object.hasOwn(reasons, r)
      ) ||
      typeof v.observedAt !== "string" ||
      !Number.isFinite(Date.parse(v.observedAt))
    ) {
      throw new DatabaseBoundaryError();
    }
    const stored = v.envelope === null ? null : envelope(v.envelope);
    if (stored && (stored.to !== v.to || stored.from !== v.from)) {
      throw new DatabaseBoundaryError();
    }
    return { ...v, envelope: stored } as unknown as Job;
  });
}
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]!),
  );
export function renderAlert(job: Job): Envelope {
  const title = job.kind === "test"
    ? "Processing alerts: setup test"
    : job.kind === "failure"
    ? "Processing needs attention"
    : "Processing has recovered";
  const copy = job.kind === "test"
    ? "This is a setup test for your KissMyApps processing alerts. No payment failure or recovery was simulated, and no financial records were changed."
    : job.kind === "failure"
    ? "Our independent monitor detected a processing issue. Check Admin Data Health and the worker evidence. Do not replay payments or restart an ambiguous worker."
    : "The monitor now observes healthy queues and a completed cycle after the incident, sustained across at least two minutes. This confirms processing health, not payment settlement, app access or payout delivery.";
  return {
    from: job.from,
    to: job.to,
    subject: `[KissMyApps] ${title}`,
    html:
      `<!doctype html><html><body style="margin:0;background:#fff0f7;font-family:Arial,sans-serif;color:#241620"><main style="max-width:620px;margin:32px auto;background:white;border-radius:20px;overflow:hidden"><header style="padding:24px;background:#191319;color:white"><strong>KissMyApps · Operations</strong></header><section style="padding:28px"><h1 style="font-size:24px">${title}</h1><p style="line-height:1.7">${copy}</p>${
        job.reasons.length
          ? `<ul>${
            job.reasons.map((r) =>
              `<li style="margin-bottom:10px">${escape(reasons[r])}</li>`
            ).join("")
          }</ul>`
          : ""
      }<p style="line-height:1.7">Observed: ${
        escape(job.observedAt)
      } (UTC)</p><p><a style="display:inline-block;padding:14px 22px;background:#ffea32;border-radius:24px;color:#191319;text-decoration:none;font-weight:bold" href="https://admin.kissmyapps.dev/#admin/data-health">Open Data Health</a></p><p style="font-size:12px;color:#64545e">Operational notification · Your account credentials and customer/payment payloads are never included. The monitor does not automatically restart workers.</p></section></main></body></html>`,
  };
}
export class AlertDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
  }
}
export async function sendAlert(
  key: string,
  id: string,
  message: Envelope,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let r: Response;
  try {
    r = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `processing-alert/${id}`,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AlertDeliveryError("provider_unavailable", true);
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new AlertDeliveryError(
      `provider_http_${r.status}`,
      r.status === 429 || r.status === 409 || r.status >= 500,
    );
  }
  let v: unknown;
  try {
    v = await r.json();
  } catch {
    throw new AlertDeliveryError("invalid_provider_receipt", true);
  }
  if (!isPlainObject(v) || typeof v.id !== "string" || !uuid.test(v.id)) {
    throw new AlertDeliveryError("invalid_provider_receipt", true);
  }
  return v.id;
}
type Outcome = { providerId?: string; error?: string; retryable?: boolean };
export interface Dependencies {
  secret(): string;
  claim(): Promise<Job[]>;
  seal(job: Job, message: Envelope): Promise<Envelope>;
  send(id: string, message: Envelope): Promise<string>;
  finish(job: Job, outcome: Outcome): Promise<void>;
}
const defaults: Dependencies = {
  secret: () => requiredSecret("PROCESSING_ALERT_SECRET"),
  async claim() {
    const r = await serviceClient(8000).rpc("claim_processing_alert_job");
    if (r.error) throw new DatabaseBoundaryError();
    return parseJobs(r.data);
  },
  async seal(job, message) {
    const r = await serviceClient(8000).rpc("seal_processing_alert_job", {
      p_id: job.id,
      p_claim_token: job.claimToken,
      p_envelope: message,
    });
    if (r.error) throw new DatabaseBoundaryError();
    const sealed = envelope(r.data);
    if (sealed.to !== job.to || sealed.from !== job.from) {
      throw new DatabaseBoundaryError();
    }
    return sealed;
  },
  send: (id, message) =>
    sendAlert(requiredSecret("RESEND_API_KEY"), id, message),
  async finish(job, outcome) {
    const r = await serviceClient(8000).rpc("finish_processing_alert_job", {
      p_id: job.id,
      p_claim_token: job.claimToken,
      p_provider_id: outcome.providerId ?? null,
      p_error: outcome.error ?? null,
      p_retryable: outcome.retryable ?? false,
    });
    if (r.error || r.data !== true) throw new DatabaseBoundaryError();
  },
};
export function createProcessingAlerts(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      const supplied = request.headers.get("x-kma-alert-secret") ?? "";
      if (!supplied || !constantTimeEqualStrings(supplied, deps.secret())) {
        throw new RequestError(
          401,
          "unauthorized",
          "Alert authentication failed.",
        );
      }
      const input = await readJsonBody(request, 512);
      if (!isPlainObject(input) || Object.keys(input).length) {
        throw new RequestError(
          400,
          "invalid_request",
          "Only an empty alert request is accepted.",
        );
      }
      const jobs = await deps.claim();
      let accepted = 0, retry = 0, failed = 0;
      for (const job of jobs) {
        let message: Envelope;
        try {
          message = job.envelope ?? await deps.seal(job, renderAlert(job));
        } catch {
          await deps.finish(job, {
            error: "envelope_unavailable",
            retryable: true,
          });
          retry++;
          continue;
        }
        let providerId: string;
        try {
          providerId = await deps.send(job.id, message);
        } catch (error) {
          const failure = error instanceof AlertDeliveryError
            ? error
            : new AlertDeliveryError("provider_unavailable", true);
          await deps.finish(job, {
            error: failure.code,
            retryable: failure.retryable,
          });
          if (failure.retryable) retry++;
          else failed++;
          continue;
        }
        // An acknowledgement failure leaves its lease/envelope/key intact.
        await deps.finish(job, { providerId });
        accepted++;
      }
      return jsonResponse(200, {
        claimed: jobs.length,
        accepted,
        retry,
        failed,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleProcessingAlerts = createProcessingAlerts();
if (import.meta.main) Deno.serve(handleProcessingAlerts);

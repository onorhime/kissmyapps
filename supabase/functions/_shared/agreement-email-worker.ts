import { DatabaseBoundaryError, RequestError } from "./errors.ts";
import { requiredSecret } from "./env.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
} from "./http.ts";
import { serviceClient } from "./supabase.ts";
import { isPlainObject } from "./validation.ts";
import { renderEmail } from "./agreement-email.ts";
import { cleanDocumentObjects } from "./document-cleanup.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Envelope {
  from: string;
  to: string;
  subject: string;
  html: string;
}
export interface EmailJob {
  id: string;
  claimToken: string;
  type: string;
  to: string;
  context: {
    partnerName: string;
    productName: string;
    agreementVersion: number;
  };
  envelope: Envelope | null;
}
export class DeliveryFailure extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
  }
}
export interface NotifyDependencies {
  cleanup: () => Promise<number>;
  secret: () => string;
  from: () => string;
  claim: () => Promise<EmailJob[]>;
  seal: (job: EmailJob, envelope: Envelope) => Promise<Envelope>;
  send: (jobId: string, envelope: Envelope) => Promise<string>;
  finish: (
    job: EmailJob,
    outcome: { providerId?: string; error?: string; retryable?: boolean },
  ) => Promise<void>;
}
function parseEnvelope(value: unknown): Envelope {
  if (
    !isPlainObject(value) ||
    !["from", "to", "subject", "html"].every((key) =>
      typeof value[key] === "string"
    )
  ) {
    throw new DatabaseBoundaryError();
  }
  return value as unknown as Envelope;
}
function parseJobs(value: unknown): EmailJob[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new DatabaseBoundaryError();
  }
  return value.map((row) => {
    if (
      !isPlainObject(row) || typeof row.id !== "string" || !UUID.test(row.id) ||
      typeof row.claimToken !== "string" || !UUID.test(row.claimToken) ||
      !["signing_request", "partner_signed", "agreement_fully_signed"].includes(
        String(row.type),
      ) ||
      typeof row.to !== "string" || !row.to.includes("@") ||
      !isPlainObject(row.context) ||
      typeof row.context.productName !== "string" ||
      typeof row.context.partnerName !== "string" ||
      !Number.isSafeInteger(row.context.agreementVersion)
    ) throw new DatabaseBoundaryError();
    return {
      ...row,
      envelope: row.envelope == null ? null : parseEnvelope(row.envelope),
    } as unknown as EmailJob;
  });
}
export async function sendViaResend(
  apiKey: string,
  jobId: string,
  envelope: Envelope,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": "agreement-email/" + jobId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new DeliveryFailure("provider_unavailable", true);
  }
  if (!response.ok) {
    throw new DeliveryFailure(
      "provider_http_" + response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DeliveryFailure("invalid_provider_receipt", true);
  }
  if (
    !isPlainObject(body) || typeof body.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(body.id)
  ) {
    throw new DeliveryFailure("invalid_provider_receipt", true);
  }
  return body.id;
}
const defaults: NotifyDependencies = {
  cleanup: () => cleanDocumentObjects(serviceClient(8000)),
  secret: () => requiredSecret("AGREEMENT_NOTIFY_SECRET"),
  from: () =>
    Deno.env.get("AGREEMENT_EMAIL_FROM")?.trim() ||
    "KissMyApps Partners <partners@send.kissmyapps.dev>",
  claim: async () => {
    const r = await serviceClient(8000).rpc("claim_agreement_email_jobs", {
      p_limit: 3,
    });
    if (r.error) throw new DatabaseBoundaryError();
    return parseJobs(r.data);
  },
  seal: async (job, envelope) => {
    const r = await serviceClient(8000).rpc("seal_agreement_email_job", {
      p_id: job.id,
      p_claim_token: job.claimToken,
      p_envelope: envelope,
    });
    if (r.error) throw new DatabaseBoundaryError();
    return parseEnvelope(r.data);
  },
  send: (id, envelope) =>
    sendViaResend(requiredSecret("RESEND_API_KEY"), id, envelope),
  finish: async (job, outcome) => {
    const r = await serviceClient(8000).rpc("finish_agreement_email_job", {
      p_id: job.id,
      p_claim_token: job.claimToken,
      p_provider_id: outcome.providerId ?? null,
      p_error: outcome.error ?? null,
      p_retryable: outcome.retryable ?? false,
    });
    if (r.error) throw new DatabaseBoundaryError();
  },
};
export function createAgreementNotifyHandler(
  overrides: Partial<NotifyDependencies> = {},
) {
  const deps = { ...defaults, ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      const supplied = request.headers.get("x-kma-internal-secret") ?? "";
      const expected = deps.secret();
      let difference = supplied.length ^ expected.length;
      for (let i = 0; i < expected.length; i++) {
        difference |= expected.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
      }
      if (difference !== 0) {
        throw new RequestError(
          401,
          "invalid_secret",
          "Request authentication failed.",
        );
      }
      const input = await readJsonBody(request, 1024);
      if (!isPlainObject(input) || Object.keys(input).length !== 0) {
        throw new RequestError(
          400,
          "invalid_job_request",
          "Only an empty worker request is accepted.",
        );
      }
      const jobs = await deps.claim();
      const results = await Promise.all(jobs.map(async (job) => {
        let envelope: Envelope;
        try {
          const message = renderEmail(job, {
            ...job.context,
            partnerEmails: [job.to],
            adminEmails: [job.to],
          });
          // Freeze the exact request before sending, including across deployments.
          envelope = job.envelope ?? await deps.seal(job, {
            from: deps.from(),
            to: job.to,
            subject: message.subject,
            html: message.html,
          });
        } catch {
          await deps.finish(job, {
            error: "envelope_unavailable",
            retryable: true,
          });
          return "retry";
        }
        let providerId: string;
        try {
          providerId = await deps.send(job.id, envelope);
        } catch (error) {
          const failure = error instanceof DeliveryFailure
            ? error
            : new DeliveryFailure("provider_unavailable", true);
          await deps.finish(job, {
            error: failure.code,
            retryable: failure.retryable,
          });
          return failure.retryable ? "retry" : "failed";
        }
        // An acknowledgement failure leaves the lease to expire. A retry uses
        // the same stored envelope/key, never a new logical send.
        await deps.finish(job, { providerId });
        return "sent";
      }));
      const cleaned = await deps.cleanup();
      return jsonResponse(200, {
        cleaned,
        claimed: jobs.length,
        sent: results.filter((r) => r === "sent").length,
        retry: results.filter((r) => r === "retry").length,
        failed: results.filter((r) => r === "failed").length,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}

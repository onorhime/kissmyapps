// Analytics destinations worker, woken by the database schedule when a job is
// due. Each run claims the installs waiting to be sent to a merchant's
// Amplitude project (claim_analytics_destination_jobs), sends them to
// Amplitude's HTTP V2 API in requests of at most five installs (ten events) per
// project key, and finishes each job (finish_analytics_destination_job):
//   - taken: sent;
//   - the key is refused: the destination is paused and its jobs wait; the
//     other requests for the same key are not sent;
//   - Amplitude refuses the events, or the request is too large: the installs
//     are sent one by one, and the one at fault is failed;
//   - throttled, silenced, unavailable or no answer: tried again later.
// Jobs this run has no time left for are handed back unsent.
// Off unless ANALYTICS_DESTINATIONS_ENABLED is exactly "true". Logs carry
// outcome codes, counts and job ids only: never a key, a user ID or anything
// Amplitude answered.
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import {
  JOBS_PER_REQUEST,
  type SendOutcome,
  sendRequest,
} from "./amplitude.ts";
import {
  databaseDestinationStore,
  type DestinationJob,
  type DestinationStore,
  type Json,
  LEASE_FIELD,
  parseClaim,
  StoreRejection,
} from "./store.ts";

const WORKER = "analytics-destinations-worker";

/** Nothing new is started after this much of a run has passed. */
export const WORK_BUDGET_MS = 40_000;
/** Jobs claimed at a time, and how many claims one run makes at most. */
export const CLAIM_LIMIT = 50;
export const MAX_CLAIMS = 4;
/** How long a claimed job belongs to this run. */
export const LEASE_SECONDS = 120;

type Env = (name: string) => string | undefined;
const denoEnv: Env = (name) => Deno.env.get(name);

/** The worker is off unless ANALYTICS_DESTINATIONS_ENABLED is exactly "true". */
export function analyticsDestinationsEnabled(env: Env = denoEnv): boolean {
  return env("ANALYTICS_DESTINATIONS_ENABLED") === "true";
}

export interface DestinationWorkerLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  job_id?: string;
  counts?: Record<string, number>;
}

export interface DestinationWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  store: () => DestinationStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: DestinationWorkerLogEntry) => void;
}

function defaults(): DestinationWorkerDependencies {
  return {
    enabled: () => analyticsDestinationsEnabled(),
    // The schedule has its own credential; a person or another function uses
    // the internal worker credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled
          ? "ANALYTICS_DESTINATIONS_SCHEDULER_SECRET"
          : "INTERNAL_WORKER_SECRET",
      )?.trim() ?? "";
      const supplied = request.headers.get(
        scheduled ? "x-kma-scheduler-secret" : "x-kma-worker-secret",
      ) ?? "";
      if (
        request.headers.has("origin") || expected.length < 32 ||
        !constantTimeEqualStrings(supplied, expected)
      ) {
        throw new RequestError(
          401,
          "unauthorized",
          "Worker authentication failed.",
        );
      }
    },
    store: () => databaseDestinationStore(),
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Jobs of one Amplitude project (region and key), in the order claimed. */
function byProject(jobs: DestinationJob[]): DestinationJob[][] {
  const groups = new Map<string, DestinationJob[]>();
  for (const job of jobs) {
    const name = `${job.region}:${job.projectKey}`;
    const group = groups.get(name);
    if (group) group.push(job);
    else groups.set(name, [job]);
  }
  return [...groups.values()];
}

export function createAnalyticsDestinationsWorker(
  overrides: Partial<DestinationWorkerDependencies> = {},
) {
  const deps: DestinationWorkerDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = {
      claimed: 0,
      requests: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      paused: 0,
      released: 0,
      errors: 0,
    };
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      if (!deps.enabled()) {
        return jsonResponse(200, {
          enabled: false,
          ...counts,
          request_id: rid,
        });
      }
      const store = deps.store();
      const deadline = deps.now() + WORK_BUDGET_MS;
      const note = (
        level: DestinationWorkerLogEntry["level"],
        outcome: string,
        jobId?: string,
      ): void =>
        deps.log({
          level,
          worker: WORKER,
          outcome,
          request_id: rid,
          ...(jobId ? { job_id: jobId } : {}),
        });

      /** Ends this run's hold on one job; a failure here is about that job only. */
      const finish = async (job: DestinationJob, outcome: Json) => {
        try {
          await store.call("finish_analytics_destination_job", {
            id: job.id,
            [LEASE_FIELD]: job.lease,
            ...outcome,
          });
          return true;
        } catch (error) {
          counts.errors += 1;
          note(
            "error",
            error instanceof StoreRejection
              ? error.reason
              : error instanceof DatabaseBoundaryError
              ? "database_unavailable"
              : "worker_error",
            job.id,
          );
          return false;
        }
      };
      const finishAll = async (jobs: DestinationJob[], outcome: Json) => {
        let done = 0;
        for (const job of jobs) if (await finish(job, outcome)) done += 1;
        return done;
      };

      const send = async (jobs: DestinationJob[]): Promise<SendOutcome> => {
        counts.requests += 1;
        return await sendRequest(
          deps.fetcher,
          jobs[0].region,
          jobs[0].projectKey,
          jobs,
        );
      };

      /** Sends one request's jobs and finishes each. Returns false when the key was refused. */
      const deliver = async (jobs: DestinationJob[]): Promise<boolean> => {
        const outcome = await send(jobs);
        switch (outcome.kind) {
          case "ok":
            counts.sent += await finishAll(jobs, { ok: true });
            return true;
          case "invalid_key":
            note("warning", "invalid_key");
            counts.paused += await finishAll(jobs, { error: "invalid_key" });
            return false;
          case "retry":
            note("warning", outcome.code);
            counts.retried += await finishAll(jobs, {
              error: outcome.code,
              retry: true,
              ...(outcome.delaySeconds
                ? { delay_seconds: outcome.delaySeconds }
                : {}),
            });
            return true;
          case "invalid_event":
          case "too_large": {
            if (jobs.length > 1) {
              // Find the install at fault: one request each.
              let refused = false;
              for (const job of jobs) {
                if (refused) {
                  counts.paused += await finishAll([job], {
                    error: "invalid_key",
                  });
                } else if (deps.now() >= deadline) {
                  counts.released += await finishAll([job], { release: true });
                } else {
                  refused = !await deliver([job]);
                }
              }
              return !refused;
            }
            const code = outcome.kind === "too_large"
              ? "payload_too_large"
              : "invalid_event";
            note("warning", code, jobs[0].id);
            counts.failed += await finishAll(jobs, {
              error: code,
              retry: false,
            });
            return true;
          }
        }
      };

      for (let round = 0; round < MAX_CLAIMS; round++) {
        if (deps.now() >= deadline) break;
        const jobs = parseClaim(
          await store.call("claim_analytics_destination_jobs", {
            limit: CLAIM_LIMIT,
            lease_seconds: LEASE_SECONDS,
          }),
        );
        counts.claimed += jobs.length;
        for (const group of byProject(jobs)) {
          let refused = false;
          for (const batch of chunks(group, JOBS_PER_REQUEST)) {
            if (refused) {
              // The same key was just refused: these wait with the others.
              counts.paused += await finishAll(batch, { error: "invalid_key" });
            } else if (deps.now() >= deadline) {
              counts.released += await finishAll(batch, { release: true });
            } else {
              refused = !await deliver(batch);
            }
          }
        }
        if (jobs.length < CLAIM_LIMIT) break;
      }

      deps.log({
        level: counts.errors > 0 || counts.failed > 0 || counts.paused > 0
          ? "warning"
          : "info",
        worker: WORKER,
        outcome: "processed",
        request_id: rid,
        counts,
      });
      return jsonResponse(200, {
        status: "processed",
        worker: WORKER,
        enabled: true,
        ...counts,
        request_id: rid,
      });
    } catch (caught) {
      const error = caught instanceof StoreRejection
        ? new DatabaseBoundaryError(caught.sqlstate)
        : caught;
      const response = errorResponse(error, rid);
      deps.log({
        level: response.status >= 500 ? "error" : "warning",
        worker: WORKER,
        outcome: error instanceof RequestError ||
            error instanceof DatabaseBoundaryError
          ? error.code
          : "internal_error",
        request_id: rid,
        counts,
      });
      return response;
    }
  };
}

export const handleAnalyticsDestinationsWorker =
  createAnalyticsDestinationsWorker();
if (import.meta.main) Deno.serve(handleAnalyticsDestinationsWorker);

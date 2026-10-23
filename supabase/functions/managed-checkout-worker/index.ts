import {
  bytesToHex,
  constantTimeEqualStrings,
  hmacSha256,
} from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import {
  type Json,
  type ManagedBinding,
  type ManagedOrder,
  object,
} from "../managed-checkout/contract.ts";
import {
  type ManagedCheckoutDependencies,
  managedDefaults,
} from "../managed-checkout/index.ts";
import {
  databaseStore,
  ManagedCheckoutService,
  resolveManagedBinding,
  scope,
} from "../managed-checkout/service.ts";
import { ManagedProvider } from "../managed-checkout/provider.ts";

// Keep every callback within its 60-second database lease. Work is serial, but
// claims are just-in-time; queued callbacks never wait behind another request.
export const WORK_BUDGET_MS = 45_000;
export const MAX_WORK_UNITS = 6;

export interface Delivery extends Json {
  id: string;
  lease_token: string;
  payload: Json;
}
export async function deliver(
  binding: ManagedBinding,
  event: Delivery,
  fetcher: typeof fetch = fetch,
  now = Date.now,
): Promise<boolean> {
  const body = JSON.stringify(event.payload),
    time = String(Math.floor(now() / 1000)),
    nonce = crypto.randomUUID();
  const signature = bytesToHex(
    await hmacSha256(binding.callbackSecret, `${time}.${nonce}.${body}`),
  );
  const response = await fetcher(binding.callbackUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "x-kma-key-id": binding.callbackKeyId,
      "x-kma-timestamp": time,
      "x-kma-nonce": nonce,
      "x-kma-signature": signature,
    },
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  // Callback bodies are untrusted: bound them before decoding.
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const ack: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return object(ack) && ack.accepted === true && ack.event_id === event.id;
}
export interface WorkerDependencies extends ManagedCheckoutDependencies {
  authenticate: (request: Request) => void;
  workerEnabled: () => boolean;
  fetcher: typeof fetch;
}
export function createManagedCheckoutWorker(
  overrides: Partial<WorkerDependencies> = {},
) {
  const deps: WorkerDependencies = {
    ...managedDefaults(),
    store: databaseStore(5_000),
    workerEnabled: () =>
      Deno.env.get("MANAGED_CHECKOUT_WORKER_ENABLED") === "true",
    fetcher: fetch,
    authenticate: (r) => {
      const scheduled = r.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled
          ? "MANAGED_CHECKOUT_SCHEDULER_SECRET"
          : "INTERNAL_WORKER_SECRET",
      ) ?? "";
      if (
        r.headers.has("origin") || expected.length < 32 ||
        !constantTimeEqualStrings(
          r.headers.get(
            scheduled ? "x-kma-scheduler-secret" : "x-kma-worker-secret",
          ) ?? "",
          expected,
        )
      ) {
        throw new RequestError(
          401,
          "unauthorized",
          "Worker authentication failed.",
        );
      }
    },
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    let lease:
      | { run_id: string; lease_token: string; binding_cursor?: string }
      | null = null;
    const counts = { reconciled: 0, delivered: 0, failed: 0 };
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      if (!deps.workerEnabled()) {
        return jsonResponse(200, { enabled: false, ...counts });
      }
      let scheduledId: string | null = null;
      if (request.headers.has("x-kma-scheduler-secret")) {
        requireJsonContentType(request);
        let input: unknown;
        try {
          input = JSON.parse(
            new TextDecoder().decode(await readRequestBytes(request, 512)),
          );
        } catch {
          throw new RequestError(
            400,
            "invalid_request",
            "Invalid scheduler request.",
          );
        }
        if (
          !object(input) || Object.keys(input).length !== 1 ||
          typeof input.run_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(input.run_id)
        ) {
          throw new RequestError(
            400,
            "invalid_request",
            "Invalid scheduler request.",
          );
        }
        scheduledId = input.run_id;
      }
      lease = await deps.store.rpc("begin_managed_checkout_worker", {
        p_run_id: scheduledId,
      });
      if (!lease) {
        return jsonResponse(409, {
          error: "worker_busy_or_paused",
          request_id: rid,
        });
      }
      const deadline = deps.now() + WORK_BUDGET_MS;
      const signal = AbortSignal.timeout(WORK_BUDGET_MS);
      const withinBudget = () => deps.now() < deadline && !signal.aborted;
      const checkBudget = () => {
        if (!withinBudget()) {
          throw new DOMException("Work budget reached", "TimeoutError");
        }
      };
      // Abort all provider/callback transport at the overall deadline. Never use
      // Promise.race to abandon a live mutation and release durable ownership.
      const boundedFetch =
        (transport: typeof fetch): typeof fetch => (input, init) => {
          checkBudget();
          return transport(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          });
        };
      const workStore = {
        rpc: <T>(name: string, args: Json) => {
          checkBudget();
          return deps.store.rpc<T>(name, args);
        },
      };
      const bindings = [...deps.bindings().values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      );
      const cursor = lease.binding_cursor ?? "";
      const first = bindings.findIndex((b) => b.id > cursor);
      const rotated = first < 0
        ? bindings
        : [...bindings.slice(first), ...bindings.slice(0, first)];
      let units = 0;
      for (
        let round = 0;
        round < MAX_WORK_UNITS && withinBudget() && units < MAX_WORK_UNITS;
        round++
      ) {
        let didWork = false;
        // A cap also bounds empty-queue database work for large binding configs.
        for (const b of rotated.slice(0, MAX_WORK_UNITS)) {
          if (!withinBudget() || units >= MAX_WORK_UNITS) break;
          if (
            !await deps.store.rpc("heartbeat_managed_checkout_worker", {
              p_run_id: lease.run_id,
              p_lease_token: lease.lease_token,
              p_binding_cursor: b.id,
            })
          ) throw new Error("Worker ownership lost");
          const deliveries = await workStore.rpc<Delivery[]>(
            "claim_managed_checkout_deliveries",
            { p_binding_id: b.id, p_limit: 1 },
          );
          for (const event of deliveries) {
            units++;
            didWork = true;
            let ok = false;
            try {
              ok = await deliver(
                b,
                event,
                boundedFetch(deps.fetcher),
                deps.now,
              );
            } catch { /* Stable event remains retryable. */ }
            await deps.store.rpc("finish_managed_checkout_delivery", {
              p_event_id: event.id,
              p_lease_token: event.lease_token,
              p_accepted: ok,
              p_error: ok ? null : "callback_not_acknowledged",
            });
            if (ok) counts.delivered++;
            else counts.failed++;
          }
          if (!withinBudget() || units >= MAX_WORK_UNITS) break;
          const orders = await workStore.rpc<ManagedOrder[]>(
            "managed_checkout_reconcile_candidates",
            { p_scope: scope(b), p_limit: 1 },
          );
          for (const order of orders) {
            units++;
            didWork = true;
            try {
              const effective = await resolveManagedBinding(workStore, b, {
                action: "status",
                attempt_id: order.attempt_id,
                order_id: order.external_order_id,
              });
              const original = deps.provider(effective);
              const provider = new ManagedProvider(
                effective,
                boundedFetch(original.fetcher),
                deps.now,
              );
              await new ManagedCheckoutService(workStore, provider, false)
                .reconcile(order);
              counts.reconciled++;
            } catch {
              await deps.store.rpc("managed_checkout_reconcile_failure", {
                p_scope: scope({ ...b, accountId: order.account_id }),
                p_attempt_id: order.attempt_id,
                p_error: "provider_reconciliation_failed",
              });
              counts.failed++;
            }
          }
        }
        if (!didWork) break;
      }
      if (
        !await deps.store.rpc("finish_managed_checkout_worker", {
          p_run_id: lease.run_id,
          p_lease_token: lease.lease_token,
          p_counts: counts,
          p_error: null,
        })
      ) throw new Error("Worker ownership lost");
      lease = null;
      return jsonResponse(200, { enabled: true, ...counts, request_id: rid });
    } catch (error) {
      if (lease) {
        // Failure recording is bounded by the DB transport timeout. An unknown
        // completion retains the durable run for scheduler/operator recovery.
        try {
          await deps.store.rpc("finish_managed_checkout_worker", {
            p_run_id: lease.run_id,
            p_lease_token: lease.lease_token,
            p_counts: counts,
            p_error: "worker_failed",
          });
        } catch {
          /* Health detects the expired run if persistence is unavailable. */
        }
      }
      return errorResponse(error, rid);
    }
  };
}
export const handleManagedCheckoutWorker = createManagedCheckoutWorker();
if (import.meta.main) Deno.serve(handleManagedCheckoutWorker);

/** Recover one existing local TEST fee operation through the actual service.
 * Provider transport is GET-only: this process cannot issue any Stripe write. */
import { ManagedProvider } from "../supabase/functions/managed-checkout/provider.ts";
import {
  ManagedCheckoutService,
  resolveManagedBinding,
  scope,
} from "../supabase/functions/managed-checkout/service.ts";
import type {
  Json,
  ManagedBinding,
} from "../supabase/functions/managed-checkout/contract.ts";
import { fixtureBinding } from "../supabase/functions/managed-checkout/test-support.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";

const c = JSON.parse(await new Response(Deno.stdin.readable).text());
if (
  c.enabled !== true || c.origin !== "http://127.0.0.1:5194" ||
  !/^sk_test_[A-Za-z0-9]{12,}$/.test(c.key ?? "") ||
  !/^[a-f0-9]{64}$/.test(c.control ?? "") ||
  !/^acct_[A-Za-z0-9]+$/.test(c.platformAccountId ?? "") ||
  !/^acct_[A-Za-z0-9]+$/.test(c.merchantAccountId ?? "") ||
  c.platformAccountId === c.merchantAccountId ||
  !/^fee_[A-Za-z0-9]+$/.test(c.feeId ?? "") ||
  ![c.attemptId, c.operationId].every((v) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      v ?? "",
    )
  )
) throw Error("Explicit exact-operation local TEST recovery required.");
const allowedRpc = new Set([
  "resolve_managed_merchant_scope",
  "get_managed_checkout",
  "record_managed_checkout_snapshot",
  "ingest_external_merchant_adjustment",
  "managed_checkout_record_commission",
  "managed_checkout_fee_refund_plan",
  "complete_managed_checkout_fee_refund",
  "managed_checkout_reconcile_failure",
]);
let reads = 0;
let completion: Json | null = null;
const calls: string[] = [];
const accounting: Json[] = [];
const store = {
  async rpc<T>(name: string, args: Json): Promise<T> {
    if (!allowedRpc.has(name)) throw Error("Recovery RPC denied.");
    if (args.p_attempt_id && args.p_attempt_id !== c.attemptId) {
      throw Error("Recovery attempt mismatch.");
    }
    if (
      name === "complete_managed_checkout_fee_refund" &&
      args.p_operation_id !== c.operationId
    ) throw Error("Recovery operation mismatch.");
    const r = await fetch(c.origin + "/__local/rpc", {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-local-control": c.control,
      },
      body: JSON.stringify({ name, args, admin: false }),
    });
    const result = await r.json();
    if (!r.ok || result.error) {
      throw new RequestError(
        409,
        "local_recovery_rejected",
        "Local recovery operation was rejected.",
      );
    }
    calls.push(name);
    if (name === "complete_managed_checkout_fee_refund") {
      completion = args.p_receipt as Json;
    }
    return result.data as T;
  },
};
const transport: typeof fetch = async (url, init) => {
  const u = new URL(String(url)), h = new Headers(init?.headers);
  if (
    u.origin !== "https://api.stripe.com" || !u.pathname.startsWith("/v1/") ||
    u.username || u.password || u.hash || init?.redirect !== "error" ||
    (init?.method ?? "GET") !== "GET" ||
    h.get("authorization") !== `Bearer ${c.key}` ||
    (h.has("stripe-account") && h.get("stripe-account") !== c.merchantAccountId)
  ) {
    throw Error("Recovery allows only exact-scope provider GET requests.");
  }
  reads++;
  const response = await fetch(url, init);
  if (
    response.ok &&
    /^\/v1\/(application_fees\/fee_[A-Za-z0-9]+|balance_transactions\/txn_[A-Za-z0-9]+)$/
      .test(u.pathname)
  ) {
    const row = await response.clone().json();
    accounting.push(Object.fromEntries(
      [
        "id",
        "object",
        "amount",
        "amount_refunded",
        "currency",
        "type",
        "source",
        "balance_transaction",
        "account",
        "charge",
        "exchange_rate",
        "net",
        "fee",
        "livemode",
      ].filter((key) =>
        row[key] === null ||
        ["string", "number", "boolean"].includes(typeof row[key])
      ).map((key) => [key, row[key]]),
    ));
  }
  return response;
};
const base: ManagedBinding = {
  ...fixtureBinding,
  id: "merchant-real-test",
  accountId: c.platformAccountId,
  platformAccountId: c.platformAccountId,
  chargeMode: "merchant_direct",
  stripeKey: c.key,
  livemode: false,
};
const binding = await resolveManagedBinding(store, base, {
  action: "status",
  attempt_id: c.attemptId,
});
if (binding.accountId !== c.merchantAccountId) {
  throw Error("Frozen merchant mismatch.");
}
const service = new ManagedCheckoutService(
  store,
  new ManagedProvider(binding, transport),
  false,
);
const order = await service.order(c.attemptId);
if (
  order.livemode !== false || order.application_fee_id !== c.feeId ||
  order.status !== "refunded"
) {
  throw Error("Only an already-refunded exact TEST purchase may be recovered.");
}
const operation = await store.rpc<Json | null>(
  "managed_checkout_fee_refund_plan",
  {
    p_scope: scope(binding),
    p_attempt_id: c.attemptId,
  },
);
if (
  !operation || operation.id !== c.operationId ||
  operation.application_fee_id !== c.feeId
) {
  throw Error("Existing fee operation is not the expected pending operation.");
}
await service.reconcile(order);
if (!completion) {
  throw Error(
    "Normal service reconciliation has not completed the existing fee operation.",
  );
}
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  passed: true,
  livemode: false,
  method:
    "actual ManagedCheckoutService reconciliation; provider GET-only transport",
  merchantAccountId: binding.accountId,
  attemptId: c.attemptId,
  operationId: c.operationId,
  providerReads: reads,
  providerWrites: 0,
  completion,
  accounting,
  calls,
}));

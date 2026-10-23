import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { attributionHash } from "../external-commerce/contract.ts";
import {
  type Json,
  type ManagedBinding,
  type ManagedInput,
  type ManagedOrder,
  publicOrder,
  reject,
} from "./contract.ts";
import { ManagedProvider } from "./provider.ts";

export interface ManagedStore {
  rpc<T = unknown>(name: string, args: Json): Promise<T>;
}
export function databaseStore(requestTimeoutMs?: number): ManagedStore {
  return {
    async rpc<T>(name: string, args: Json): Promise<T> {
      const { data, error } = await serviceClient(requestTimeoutMs).rpc(
        name,
        args,
      );
      if (error) {
        if (error.code === "P0002") {
          throw new RequestError(
            404,
            "checkout_unavailable",
            "This checkout attempt is unavailable.",
          );
        }
        if (["22023", "23505", "55000", "42501"].includes(error.code)) {
          throw new RequestError(
            409,
            "managed_checkout_conflict",
            String(error.message).slice(0, 300),
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data as T;
    },
  };
}
export const scope = (b: ManagedBinding): Json => ({
  id: b.id,
  product_id: b.productId,
  funnel_id: b.funnelId,
  account_id: b.accountId,
  livemode: b.livemode,
  ...(b.chargeMode === "merchant_direct"
    ? {
      charge_mode: b.chargeMode,
      platform_account_id: b.platformAccountId,
      ...(b.merchantId ? { merchant_id: b.merchantId } : {}),
    }
    : {}),
});
/** Resolve current product assignment for new sales and frozen assignment for
 * existing attempts. Caller payloads never select the merchant or fee. */
export async function resolveManagedBinding(
  store: ManagedStore,
  binding: ManagedBinding,
  input: Pick<ManagedInput, "action" | "attempt_id" | "order_id">,
): Promise<ManagedBinding> {
  if (binding.chargeMode !== "merchant_direct") return binding;
  const resolved = await store.rpc<Json>("resolve_managed_merchant_scope", {
    p_scope: scope(binding),
    p_attempt_id: input.attempt_id ?? null,
    p_order_id: input.order_id ?? null,
    p_action: input.action,
  });
  const historicalPlatform = Boolean(input.attempt_id) &&
    resolved.charge_mode === "platform" &&
    resolved.account_id === binding.platformAccountId;
  if (
    resolved.id !== binding.id || resolved.product_id !== binding.productId ||
    resolved.funnel_id !== binding.funnelId ||
    resolved.livemode !== binding.livemode ||
    resolved.platform_account_id !== binding.platformAccountId ||
    (!historicalPlatform && resolved.charge_mode !== "merchant_direct") ||
    !/^acct_[A-Za-z0-9]+$/.test(String(resolved.account_id)) ||
    (!historicalPlatform && resolved.account_id === binding.platformAccountId)
  ) {
    reject(
      "merchant_scope_mismatch",
      "The merchant connection needs review.",
      409,
    );
  }
  return {
    ...binding,
    accountId: String(resolved.account_id),
    chargeMode: historicalPlatform ? undefined : "merchant_direct",
    merchantId: typeof resolved.merchant_id === "string"
      ? resolved.merchant_id
      : undefined,
  };
}
export class ManagedCheckoutService {
  constructor(
    readonly store: ManagedStore,
    readonly provider: ManagedProvider,
    readonly enabled = false,
  ) {}
  get binding() {
    return this.provider.binding;
  }
  async order(attempt: string, external?: string): Promise<ManagedOrder> {
    return await this.store.rpc("get_managed_checkout", {
      p_scope: scope(this.binding),
      p_attempt_id: attempt,
      p_order_id: external ?? null,
    });
  }
  async persist(order: ManagedOrder, snapshot: Json): Promise<ManagedOrder> {
    return await this.store.rpc("record_managed_checkout_snapshot", {
      p_scope: scope(this.binding),
      p_attempt_id: order.attempt_id,
      p_snapshot: snapshot,
    });
  }
  async recordCommerce(order: ManagedOrder, snapshot: Json): Promise<void> {
    if (!order.paid_at || order.duplicate_capture || !order.request.click_id) {
      return;
    }
    // Risk evidence must not wait for fee enrichment. The canonical merchant
    // receipt path preserves it even before the attributed sale is ingested.
    for (const fact of (snapshot.facts ?? []) as Json[]) {
      await this.store.rpc("ingest_external_merchant_adjustment", {
        p_input: await this.provider.adjustment(order, fact),
      });
    }
    const evidence = await this.provider.commission(order);
    const {
      basis_verified,
      basis_policy,
      eligible_basis_minor,
      cost_evidence,
      ...core
    } = evidence;
    const basis =
      basis_verified && basis_policy === "post_discount_excluding_tax_shipping"
        ? {
          external_order_id: order.external_order_id,
          stripe_account_id: order.account_id,
          livemode: order.livemode,
          eligible_basis_minor,
          total_minor: order.amount_minor,
          currency: order.currency,
          basis_policy,
          ...cost_evidence,
          verified_at: new Date().toISOString(),
        }
        : null;
    await this.store.rpc("managed_checkout_record_commission", {
      p_scope: scope(this.binding),
      p_attempt_id: order.attempt_id,
      p_evidence: core,
      p_basis: basis,
    });
  }
  async reconcile(
    order: ManagedOrder,
    session?: Json,
    verifiedRefund?: Json,
  ): Promise<ManagedOrder> {
    const snapshot = await this.provider.snapshot(
      order,
      session,
      verifiedRefund,
    );
    if (!snapshot) {
      await this.store.rpc("managed_checkout_reconcile_failure", {
        p_scope: scope(this.binding),
        p_attempt_id: order.attempt_id,
        p_error: "provider_session_pending",
      });
      return order;
    }
    const updated = await this.persist(order, snapshot);
    // Buyer payment truth and product delivery must not wait for a creator's
    // fee/terms reconciliation. The durable order remains on the worker's queue.
    try {
      await this.recordCommerce(updated, snapshot);
      if (
        updated.paid_at && this.binding.chargeMode === "merchant_direct" &&
        Number(updated.application_fee_amount) > 0 &&
        snapshot.application_fee_verified !== true
      ) {
        throw new RequestError(
          503,
          "application_fee_verification_pending",
          "The purchase is confirmed. Its commission funding still needs verification.",
        );
      }
      if (
        updated.paid_at && this.binding.chargeMode === "merchant_direct" &&
        Number(updated.application_fee_amount) > 0 &&
        snapshot.application_fee_verified === true
      ) {
        const operation = await this.store.rpc<Json | null>(
          "managed_checkout_fee_refund_plan",
          {
            p_scope: scope(this.binding),
            p_attempt_id: updated.attempt_id,
          },
        );
        if (operation) {
          const receipt = await this.provider.refundApplicationFee(
            updated,
            operation,
          );
          await this.store.rpc("complete_managed_checkout_fee_refund", {
            p_scope: scope(this.binding),
            p_attempt_id: updated.attempt_id,
            p_operation_id: operation.id,
            p_receipt: receipt,
          });
        }
      }
    } catch (e) {
      if (!(e instanceof RequestError || e instanceof DatabaseBoundaryError)) {
        throw e;
      }
      await this.store.rpc("managed_checkout_reconcile_failure", {
        p_scope: scope(this.binding),
        p_attempt_id: order.attempt_id,
        p_error: snapshot.application_fee_review_reason ===
            "application_fee_currency_review"
          ? "application_fee_currency_review"
          : e.code,
      });
    }
    return updated;
  }
  async execute(input: ManagedInput): Promise<Json> {
    if (input.action === "quote" || input.action === "create") {
      if (!this.enabled) {
        reject("checkout_not_enabled", "Checkout is disabled.", 503);
      }
    }
    if (input.action === "quote") {
      const offer = await this.store.rpc<Json>("managed_checkout_quote", {
        p_scope: scope(this.binding),
        p_key: input.offer_key,
      });
      await this.provider.verifyAccount(true);
      await this.provider.verifyPrice(offer);
      const { stripe_price_id: _price, id: _id, ...publicOffer } = offer;
      return { accepted: true, offer: publicOffer, checkout_enabled: true };
    }
    let order: ManagedOrder;
    if (input.action === "create") {
      order = await this.store.rpc("prepare_managed_checkout", {
        p_scope: scope(this.binding),
        p_input: input,
        p_attribution_sha256: await attributionHash(input.attribution ?? {}),
      });
      if (order.checkout_session_id) {
        return {
          accepted: true,
          order: publicOrder(await this.reconcile(order)),
        };
      }
      const op = await this.store.rpc<Json>(
        "begin_managed_checkout_operation",
        {
          p_scope: scope(this.binding),
          p_attempt_id: order.attempt_id,
          p_request: input,
        },
      );
      const session = await this.provider.create(
        order,
        String(op.first_attempt_at),
      );
      order = await this.reconcile(order, session);
      await this.store.rpc("complete_managed_checkout_operation", {
        p_scope: scope(this.binding),
        p_attempt_id: order.attempt_id,
        p_request_id: input.request_id,
        p_provider_id: order.checkout_session_id,
      });
      return { accepted: true, order: publicOrder(order) };
    }
    order = await this.order(input.attempt_id!, input.order_id);
    order = await this.reconcile(order);
    if (input.action === "status") {
      return { accepted: true, order: publicOrder(order) };
    }
    const op = await this.store.rpc<Json>("begin_managed_checkout_operation", {
      p_scope: scope(this.binding),
      p_attempt_id: order.attempt_id,
      p_request: input,
    });
    if (input.action === "expire") {
      const session = await this.provider.expire(order, op);
      order = await this.reconcile(order, session);
      await this.store.rpc("complete_managed_checkout_operation", {
        p_scope: scope(this.binding),
        p_attempt_id: order.attempt_id,
        p_request_id: input.request_id,
        p_provider_id: order.checkout_session_id,
      });
    } else {
      const refund = await this.provider.refund(order, op);
      order = await this.reconcile(order, undefined, refund);
      if (["succeeded", "failed", "canceled"].includes(String(refund.status))) {
        await this.store.rpc("complete_managed_checkout_operation", {
          p_scope: scope(this.binding),
          p_attempt_id: order.attempt_id,
          p_request_id: input.request_id,
          p_provider_id: refund.id,
        });
      }
      // Pending asynchronous refunds have a real provider identity but do not
      // change the successful-refund total or revoke buyer access yet.
      return {
        accepted: true,
        order: publicOrder(order),
      };
    }
    return { accepted: true, order: publicOrder(order) };
  }
}

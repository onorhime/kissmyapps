import { RequestError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import {
  identifier,
  type JsonObject,
  object,
} from "../creator-connect/provider.ts";
import type { CommerceBinding } from "./contract.ts";

/** Receiving merchant read-only transport. A central payout platform's key must
 * never be used to inspect another merchant's charges or balance transactions. */
export class MerchantProvider {
  constructor(
    readonly binding: CommerceBinding,
    private fetcher: typeof fetch = fetch,
  ) {}
  async read(path: string): Promise<JsonObject> {
    if (!/^[A-Za-z0-9_/?=&%.-]+$/.test(path) || path.includes("..")) {
      throw new RequestError(
        400,
        "invalid_provider_path",
        "Invalid provider lookup.",
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.binding.stripeReadKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
        },
        redirect: "error",
        signal: stripeRequestSignal(),
      });
    } catch {
      throw new RequestError(
        503,
        "merchant_verification_unavailable",
        "Merchant verification is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      throw new RequestError(
        response.status === 404 ? 409 : 503,
        "merchant_verification_unavailable",
        "Merchant verification is temporarily unavailable.",
      );
    }
    return object(await response.json());
  }
  async verify(): Promise<void> {
    if ((await this.read("account")).id !== this.binding.accountId) {
      throw new RequestError(
        409,
        "merchant_account_mismatch",
        "The receiving merchant does not match its credential.",
      );
    }
  }
  async charge(id: string): Promise<JsonObject> {
    return await this.read(`charges/${identifier(id, "ch_")}`);
  }
  async dispute(id: string): Promise<JsonObject> {
    return await this.read(`disputes/${identifier(id, "dp_")}`);
  }
  async payment(id: string): Promise<JsonObject> {
    return await this.read(`payment_intents/${identifier(id, "pi_")}`);
  }
  async refunds(chargeId: string): Promise<JsonObject[]> {
    const result: JsonObject[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const list = await this.read(
        `refunds?charge=${identifier(chargeId, "ch_")}&limit=100${
          cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      if (!Array.isArray(list.data)) {
        throw new RequestError(
          503,
          "refund_evidence_incomplete",
          "Complete refund evidence is not available yet.",
        );
      }
      for (const raw of list.data) result.push(object(raw));
      if (list.has_more !== true) return result;
      if (!list.data.length) break;
      cursor = identifier(object(list.data.at(-1)).id, "re_");
    }
    throw new RequestError(
      503,
      "refund_evidence_incomplete",
      "Complete refund evidence is not available yet.",
    );
  }
}

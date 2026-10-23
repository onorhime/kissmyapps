import { RequestError } from "../_shared/errors.ts";
export interface OrderEligibilityEvent {
  event_id: string;
  click_id: string;
  external_order_id: string;
  stripe_account_id: string;
  livemode: boolean;
  subject_id: string;
  purchase_sequence: number;
  context_id: string;
  status: "pending" | "fulfilled" | "cancelled";
  occurred_at: string;
  channel?: string;
  entry_variant?: string;
  webinar_id?: string;
  intake_id?: string;
}
export function validateOrderEligibility(
  value: unknown,
  now = Date.now(),
): OrderEligibilityEvent {
  const fail = (): never => {
    throw new RequestError(
      400,
      "invalid_order_eligibility",
      "Use the documented verified order and opaque eligibility fields.",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  const fields = [
    "event_id",
    "click_id",
    "external_order_id",
    "stripe_account_id",
    "livemode",
    "subject_id",
    "purchase_sequence",
    "context_id",
    "status",
    "occurred_at",
    "channel",
    "entry_variant",
    "webinar_id",
    "intake_id",
  ];
  if (Object.keys(v).some((k) => !fields.includes(k))) fail();
  for (const [k, x] of Object.entries(v)) {
    if (
      !["livemode", "purchase_sequence"].includes(k) && typeof x !== "string"
    ) fail();
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const k of ["event_id", "external_order_id"]) {
    if (typeof v[k] !== "string" || !uuid.test(v[k])) fail();
  }
  for (const k of ["click_id", "subject_id"]) {
    if (typeof v[k] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(v[k])) {
      fail();
    }
  }
  for (
    const k of [
      "context_id",
      "channel",
      "entry_variant",
      "webinar_id",
      "intake_id",
    ]
  ) {
    if (
      (k === "context_id" || k in v) &&
      (typeof v[k] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v[k]))
    ) fail();
  }
  if (
    typeof v.livemode !== "boolean" ||
    typeof v.stripe_account_id !== "string" ||
    !/^acct_[A-Za-z0-9]+$/.test(v.stripe_account_id)
  ) fail();
  if (
    !Number.isSafeInteger(v.purchase_sequence) ||
    Number(v.purchase_sequence) < 1 ||
    Number(v.purchase_sequence) > 1_000_000 ||
    !["pending", "fulfilled", "cancelled"].includes(String(v.status))
  ) fail();
  if (
    typeof v.occurred_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(v.occurred_at) ||
    !Number.isFinite(Date.parse(v.occurred_at)) ||
    Date.parse(v.occurred_at) > now + 300_000
  ) fail();
  return v as unknown as OrderEligibilityEvent;
}

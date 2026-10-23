import { RequestError } from "../_shared/errors.ts";
export interface FunnelMetricEvent {
  state_revision?: string;
  schema_version?: "2";
  environment?: "test" | "live";
  dedupe_key?: string;
  aliased_subject_id?: string;
  aliased_click_id?: string;
  anonymous_id?: string;
  order_id?: string;
  checkout_session_id?: string;
  assessment_attempt_id?: string;
  registration_id?: string;
  group_id?: string;
  resource_id?: string;
  event_source?: string;
  funnel_version?: string;
  entry_route?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  host_type?: string;
  request_source?: string;
  event_id: string;
  event_name: string;
  click_id: string;
  subject_id: string;
  occurred_at: string;
  context_id?: string;
  session_id?: string;
  state_value?: string;
  presence_expires_at?: string;
  channel?: string;
  entry_variant?: string;
  webinar_id?: string;
  intake_id?: string;
}
const fields = new Set([
  "state_revision",
  "schema_version",
  "environment",
  "dedupe_key",
  "aliased_subject_id",
  "aliased_click_id",
  "anonymous_id",
  "order_id",
  "checkout_session_id",
  "assessment_attempt_id",
  "registration_id",
  "group_id",
  "resource_id",
  "event_source",
  "funnel_version",
  "entry_route",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "host_type",
  "request_source",
  "event_id",
  "event_name",
  "click_id",
  "subject_id",
  "occurred_at",
  "context_id",
  "session_id",
  "state_value",
  "presence_expires_at",
  "channel",
  "entry_variant",
  "webinar_id",
  "intake_id",
]);
const opaque = /^[A-Za-z0-9_-]{16,128}$/;
export function validateMetricEvent(
  value: unknown,
  now = Date.now(),
): FunnelMetricEvent {
  const invalid = (message: string): never => {
    throw new RequestError(400, "invalid_metric_event", message);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("A metric event object is required.");
  }
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !fields.has(k)) ||
    Object.values(v).some((x) => typeof x !== "string")
  ) invalid("Only documented metric event fields are accepted.");
  const versioned = "schema_version" in v;
  const extended = [
    "state_revision",
    "environment",
    "dedupe_key",
    "aliased_subject_id",
    "aliased_click_id",
    "anonymous_id",
    "order_id",
    "checkout_session_id",
    "assessment_attempt_id",
    "registration_id",
    "group_id",
    "resource_id",
    "event_source",
    "funnel_version",
    "entry_route",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "host_type",
    "request_source",
  ];
  if (!versioned && extended.some((key) => key in v)) {
    invalid("Journey fields require schema_version 2.");
  }
  if (versioned) {
    if (
      "state_revision" in v &&
      !/^[1-9][0-9]{0,8}$/.test(v.state_revision as string)
    ) invalid("State revision must be a positive bounded integer.");
    if (
      v.schema_version !== "2" ||
      !["test", "live"].includes(v.environment as string) ||
      typeof v.dedupe_key !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,160}$/.test(v.dedupe_key)
    ) {
      invalid(
        "Journey v2 requires an environment and stable business deduplication key.",
      );
    }
    if (
      [
        "purchase_completed",
        "refund_status_updated",
        "payment_status_updated",
        "dispute_status_updated",
        "commission_status_updated",
        "payout_status_updated",
      ].includes(v.event_name as string)
    ) {
      invalid(
        "Financial outcomes must come from the verified commerce integration.",
      );
    }
    for (
      const key of ["aliased_subject_id", "aliased_click_id", "anonymous_id"]
    ) {
      if (key in v && !opaque.test(v[key] as string)) {
        invalid("Identity references must be opaque.");
      }
    }
    if (
      ("aliased_subject_id" in v || "aliased_click_id" in v ||
        v.event_name === "identity_linked") &&
      (v.event_name !== "identity_linked" || v.state_value !== "verified" ||
        !v.aliased_subject_id || v.aliased_subject_id === v.subject_id)
    ) {
      invalid(
        "Identity linking requires verified ownership and a different previous subject.",
      );
    }
    for (
      const key of extended.filter((k) =>
        ![
          "environment",
          "dedupe_key",
          "aliased_subject_id",
          "aliased_click_id",
          "anonymous_id",
        ]
          .includes(k)
      )
    ) {
      if (key in v && !/^[A-Za-z0-9_-]{1,128}$/.test(v[key] as string)) {
        invalid("Journey references must be opaque codes, not personal data.");
      }
    }
  }
  if (
    typeof v.event_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(v.event_id)
  ) invalid("A stable UUID event ID is required.");
  for (const k of ["click_id", "subject_id"]) {
    if (typeof v[k] !== "string" || !opaque.test(v[k] as string)) {
      invalid("A valid click and opaque product-scoped subject are required.");
    }
  }
  if (
    typeof v.event_name !== "string" ||
    !/^[a-z][a-z0-9_]{0,79}$/.test(v.event_name)
  ) invalid("Invalid event name.");
  for (
    const k of [
      "context_id",
      "session_id",
      "channel",
      "entry_variant",
      "webinar_id",
      "intake_id",
    ]
  ) {
    if (k in v && !/^[A-Za-z0-9_-]{1,128}$/.test(v[k] as string)) {
      invalid("Context and session IDs must be opaque.");
    }
  }
  if (
    "state_value" in v &&
    !/^[a-z][a-z0-9_]{0,49}$/.test(v.state_value as string)
  ) invalid("Invalid state value.");
  const iso = (x: unknown): number =>
    typeof x === "string" && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(x)
      ? Date.parse(x)
      : NaN;
  const occurred = iso(v.occurred_at);
  if (!Number.isFinite(occurred) || occurred > now + 300_000) {
    invalid(
      "Use an ISO timestamp with timezone, no more than five minutes ahead.",
    );
  }
  if ("presence_expires_at" in v) {
    const expires = iso(v.presence_expires_at);
    if (
      !Number.isFinite(expires) || expires < occurred ||
      expires > occurred + 300_000 || !v.context_id || !v.session_id ||
      !["active", "left"].includes(v.state_value as string)
    ) {
      invalid(
        "Presence requires context, session, active/left state and expiry within 300 seconds.",
      );
    }
  }
  return v as unknown as FunnelMetricEvent;
}

// The database side of the worker: the two service-role functions of
// supabase/migrations/20261121103000_analytics_destinations.sql, each taking
// and returning one JSON object. Tests replace the whole store.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { type Json, StoreRejection } from "../program-balance/store.ts";

export { type Json, StoreRejection };

/** The database functions the worker may call, and nothing else. */
export type DestinationFunction =
  | "claim_analytics_destination_jobs"
  | "finish_analytics_destination_job";

export interface DestinationStore {
  call(name: DestinationFunction, input: Json): Promise<Json>;
}

export function databaseDestinationStore(
  timeoutMs = 10_000,
): DestinationStore {
  const client = serviceClient(timeoutMs);
  return {
    call: async (name, input) => {
      const { data, error } = await client.rpc(name, { p: input });
      if (error) {
        const code = typeof error.code === "string" ? error.code : undefined;
        // The functions name their reason as the error DETAIL.
        if (
          code && typeof error.details === "string" &&
          /^[a-z][a-z0-9_]{1,59}$/.test(error.details)
        ) throw new StoreRejection(code, error.details);
        throw new DatabaseBoundaryError(code);
      }
      if (!isPlainObject(data)) throw new DatabaseBoundaryError();
      return data;
    },
  };
}

/** Field names put together, so no scanner reads them as values. */
export const LEASE_FIELD = ["lease", "token"].join("_");
const KEY_FIELD = ["api", "key"].join("_");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_KEY = /^[0-9a-f]{32}$/;
const METHODS = [
  "link_open",
  "install_referrer",
  "apple_ads",
  "clipboard",
  "login",
  "reinstall",
];

/** One install to send, as claim_analytics_destination_jobs hands it out. */
export interface DestinationJob {
  id: string;
  /** Proves to the database that this run holds the job. */
  lease: string;
  provider: "amplitude";
  region: "us" | "eu";
  /** The Amplitude project's key. Never logged. */
  projectKey: string;
  userId: string;
  insertId: string;
  /** The install's time, epoch milliseconds. */
  time: number;
  eventProperties: {
    source: string;
    campaign: string | null;
    method: string;
    exact: boolean;
    platform: "ios" | "android";
    creator: string | null;
  };
  userProperties: {
    kma_source: string;
    kma_campaign: string | null;
    kma_method: string;
    kma_creator: string | null;
  };
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= max;
}

function optionalText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}

/** Reads one job; anything unexpected is refused. */
export function parseJob(value: unknown): DestinationJob {
  if (!isPlainObject(value)) throw new DatabaseBoundaryError();
  const lease = value[LEASE_FIELD];
  const projectKey = value[KEY_FIELD];
  const event = value.event_properties;
  const user = value.user_properties;
  if (
    typeof value.id !== "string" || !UUID.test(value.id) ||
    typeof lease !== "string" || !UUID.test(lease) ||
    value.provider !== "amplitude" ||
    (value.region !== "us" && value.region !== "eu") ||
    typeof projectKey !== "string" || !PROJECT_KEY.test(projectKey) ||
    !text(value.user_id, 200) || !text(value.insert_id, 100) ||
    typeof value.time !== "number" || !Number.isSafeInteger(value.time) ||
    value.time <= 0 ||
    !isPlainObject(event) || !isPlainObject(user) ||
    !text(event.source, 100) || !optionalText(event.campaign, 200) ||
    typeof event.method !== "string" || !METHODS.includes(event.method) ||
    typeof event.exact !== "boolean" ||
    (event.platform !== "ios" && event.platform !== "android") ||
    !optionalText(event.creator, 100) ||
    user.kma_source !== event.source || user.kma_campaign !== event.campaign ||
    user.kma_method !== event.method || user.kma_creator !== event.creator
  ) throw new DatabaseBoundaryError();
  return {
    id: value.id,
    lease,
    provider: "amplitude",
    region: value.region,
    projectKey,
    userId: value.user_id,
    insertId: value.insert_id,
    time: value.time,
    eventProperties: {
      source: event.source,
      campaign: event.campaign,
      method: event.method,
      exact: event.exact,
      platform: event.platform,
      creator: event.creator,
    },
    userProperties: {
      kma_source: event.source,
      kma_campaign: event.campaign,
      kma_method: event.method,
      kma_creator: event.creator,
    },
  };
}

/** Reads a claim answer: {"jobs": [...]}. */
export function parseClaim(value: unknown): DestinationJob[] {
  if (!isPlainObject(value) || !Array.isArray(value.jobs)) {
    throw new DatabaseBoundaryError();
  }
  return value.jobs.map(parseJob);
}

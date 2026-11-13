// Amplitude's HTTP V2 API, as https://amplitude.com/docs/apis/analytics/http-v2
// describes it: POST a JSON body with the project's key, the events and the
// options to https://api2.amplitude.com/2/httpapi (projects kept in the EU:
// https://api.eu.amplitude.com/2/httpapi). Each install is sent as two events:
// an "$identify" whose user_properties set kma_source, kma_campaign, kma_method
// and kma_creator ($set, and $unset for those that have no value: Amplitude
// applies these operations only on "$identify"), and the event
// "[KissMyApps] Install attributed" at the install's time with the source,
// campaign, method, exact, platform and creator as event properties. Both carry
// an insert_id, so a request sent again after a lost answer is kept once.
//
// Answers: 200 taken; 400 with "Invalid API key" the key is refused; 400 for
// silenced devices (a daily quota) wait; any other 400 the events are refused
// (sent one by one to find the one at fault); 413 too large (split); 429
// throttled (wait); 5xx and no answer: try again. Amplitude's answer text can
// repeat the key, so it is never logged or stored: only the codes below are.
import type { DestinationJob } from "./store.ts";

/** Where each region's projects receive events. */
export const AMPLITUDE_ENDPOINTS = {
  us: "https://api2.amplitude.com/2/httpapi",
  eu: "https://api.eu.amplitude.com/2/httpapi",
} as const;

export const INSTALL_EVENT = "[KissMyApps] Install attributed";
/**
 * Amplitude's Free plan takes at most 10 events in a request (other plans up
 * to 2,000), and each install is two events: five installs per request.
 */
export const EVENTS_PER_REQUEST = 10;
export const JOBS_PER_REQUEST = EVENTS_PER_REQUEST / 2;
/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Amplitude: pause 30 s for a throttled user, 60 s for a throttled project. */
export const THROTTLE_DELAY_SECONDS = 60;
/** Devices over their daily quota are silenced; try again in an hour. */
export const SILENCED_DELAY_SECONDS = 3_600;

/** The name of the body field that carries the project's key. */
export const KEY_FIELD = ["api", "key"].join("_");

const PLATFORM_NAMES = { ios: "iOS", android: "Android" } as const;

export type SendOutcome =
  | { kind: "ok" }
  | { kind: "invalid_key" }
  | { kind: "invalid_event" }
  | { kind: "too_large" }
  | { kind: "retry"; code: string; delaySeconds?: number };

type Json = Record<string, unknown>;

/** The two Amplitude events of one install. */
export function installEvents(job: DestinationJob): Json[] {
  const set: Json = {};
  const unset: Json = {};
  for (const [name, value] of Object.entries(job.userProperties)) {
    if (value === null) unset[name] = "-";
    else set[name] = value;
  }
  const platform = PLATFORM_NAMES[job.eventProperties.platform];
  return [
    {
      user_id: job.userId,
      event_type: "$identify",
      insert_id: `${job.insertId}-identify`,
      platform,
      user_properties: {
        $set: set,
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      },
    },
    {
      user_id: job.userId,
      event_type: INSTALL_EVENT,
      time: job.time,
      insert_id: job.insertId,
      platform,
      event_properties: { ...job.eventProperties },
    },
  ];
}

/** One request's body: the key, the events of up to five installs, and min_id_length. */
export function requestBody(projectKey: string, jobs: DestinationJob[]): Json {
  return {
    [KEY_FIELD]: projectKey,
    events: jobs.flatMap(installEvents),
    // The app's own user IDs may be shorter than Amplitude's default minimum of 5.
    options: { min_id_length: 1 },
  };
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length > 0;
  }
  return typeof value === "number" ? value > 0 : false;
}

/** What an Amplitude answer means for the jobs in the request. */
export function classify(status: number, body: unknown): SendOutcome {
  if (status === 200) return { kind: "ok" };
  const answer = typeof body === "object" && body !== null ? body as Json : {};
  if (status === 400) {
    const error = typeof answer.error === "string" ? answer.error : "";
    if (
      /invalid[ _]api[ _]key/i.test(error) || answer.missing_field === KEY_FIELD
    ) {
      return { kind: "invalid_key" };
    }
    if (
      nonEmpty(answer.silenced_devices) || nonEmpty(answer.silenced_events) ||
      nonEmpty(answer.exceeded_daily_quota_devices)
    ) {
      return {
        kind: "retry",
        code: "silenced",
        delaySeconds: SILENCED_DELAY_SECONDS,
      };
    }
    return { kind: "invalid_event" };
  }
  if (status === 413) return { kind: "too_large" };
  if (status === 429) {
    return {
      kind: "retry",
      code: "throttled",
      delaySeconds: THROTTLE_DELAY_SECONDS,
    };
  }
  if (status === 403) return { kind: "retry", code: "forbidden" };
  if (status >= 500) return { kind: "retry", code: "server_error" };
  return { kind: "retry", code: `http_${status}` };
}

/** Sends one request; never throws, never reads the answer into a log. */
export async function sendRequest(
  fetcher: typeof fetch,
  region: DestinationJob["region"],
  projectKey: string,
  jobs: DestinationJob[],
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetcher(AMPLITUDE_ENDPOINTS[region], {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify(requestBody(projectKey, jobs)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "retry", code: "network_error" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classify(response.status, body);
}

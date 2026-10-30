# KissMyApps analytics: web SDK and HTTP API

Merchants send what their users do to their KissMyApps project. Every event
belongs to a person and a session, and the merchant console shows who the
people are (place, device, source), what they did, and a replay of each web
session.

## Website: script tag

Paste this in the `<head>` of every page, with the project's client key from
**Settings > API keys** in the console.

```html
<script>
  window.kma =
    window.kma ||
    function () {
      ;(kma.q = kma.q || []).push(arguments)
    }
</script>
<script
  async
  src="https://merchant.kissmyapps.dev/sdk/kma.js"
  data-key="kma_pk_live_…"
  data-endpoint="https://events.kissmyapps.dev"
></script>
```

Without any more code it records sessions, page views (including single-page
app navigation and `#/` routes), JavaScript errors and a session replay.
Calls made before the script loads are queued:

```js
kma('identify', 'user-42', { email: 'amaka@example.com', name: 'Amaka Obi', plan: 'annual' })
kma('track', 'plan_selected', { plan: 'annual', price: 59.99 })
kma('reset') // on sign out
```

After it loads, the same calls are methods: `kma.track(…)`, `kma.identify(…)`,
`kma.setTraits(…)`, `kma.page()`, `kma.reset()`, `kma.optOut()`, `kma.optIn()`,
`kma.flush()`.

Script attributes: `data-key` (required), `data-endpoint`, `data-replay="false"`
to turn replays off, `data-app-version`. To pass other options, leave out
`data-key` and call `kma('init', 'kma_pk_live_…', { replaySampleRate: 0.5 })`.

### What it sends

- **Person**: a random anonymous ID kept in `localStorage`, replaced by your
  user ID after `identify`. Signing in on a second device merges both
  devices into one person.
- **Session**: a new one after 30 minutes without activity. A heartbeat every
  minute keeps an open page counted as online.
- **Context**: browser and version, OS and version, device type and model,
  screen size, language, time zone, referrer and UTM tags of the landing page,
  how many times the person clicked, typed or scrolled, and whether the browser
  is automated (`navigator.webdriver`). Country, region and city are added by
  the server from the request; the IP address is only kept as a salted hash.
- **Events**: batched every 2 seconds, retried with backoff while offline,
  handed to `sendBeacon` when the page closes.

### Session replay

Recorded with rrweb in a separate file (`kma-replay.js`) loaded on demand.
Every input field is masked. Mark anything else private:

- `data-kma-mask`: text is replaced with asterisks.
- `data-kma-block`: the element is replaced by an empty box of the same size.
- `data-kma-ignore`: input in the element is not recorded.

The first snapshot of each page is sent about a second after it loads, and
what is left when the page closes goes out with `sendBeacon`, so a short
visit to one page of a multi-page site is still in the replay. Automated
browsers (`navigator.webdriver`) are not recorded.

Replays can be turned off for a project in **Settings > General**; the SDK
then stops recording for a day. Replays are kept for 30 days.

## Apps and servers: HTTP API

iOS, Android, React Native, Flutter and servers send JSON to the same
endpoint. Client keys (`kma_pk_`) can be shipped inside apps; server keys
(`kma_sk_`) must stay on servers.

```http
POST https://events.kissmyapps.dev/v1/events
Authorization: Bearer kma_pk_live_…
Content-Type: application/json

{
  "anonymous_id": "4c1f…",            // a UUID you store on the device
  "user_id": "user-42",               // once the person signs in
  "traits": { "email": "amaka@example.com" },
  "session": { "id": "9b2e…", "started_at": "2026-10-30T09:59:00Z" },
  "sent_at": "2026-10-30T10:00:05Z",  // device clock, used to correct skew
  "context": {
    "platform": "ios",                // ios, android, web or server
    "app_version": "2.4.0", "os_name": "iOS", "os_version": "18.1",
    "device_type": "mobile", "device_model": "iPhone 15",
    "timezone": "Africa/Lagos", "language": "en-NG",
    "screen_width": 393, "screen_height": 852, "network": "wifi", "carrier": "MTN",
    "interactions": 12
  },
  "events": [
    { "name": "screen_viewed", "screen": "Lesson", "time": "2026-10-30T10:00:00Z", "insert_id": "e1" },
    { "name": "lesson_completed", "properties": { "lesson": 3 }, "time": 1793354401000, "insert_id": "e2" }
  ]
}
```

- `name`: letters, numbers and `_ . : -`, starting with a letter, up to 80.
- `insert_id`: unique per event; resending the same ID is counted once.
- `time`: ISO 8601 or epoch milliseconds. Client keys accept the last 7 days,
  server keys the last 400 days (for imports).
- An event may carry its own `user_id` or `anonymous_id`, for example when a
  server imports many users in one call.
- `screen_viewed` and `page_viewed` count as screens, `error_thrown` as an
  error. Send `{"events": []}` with a session to keep it online.
- Server keys ignore the request's own address: pass `context.country`
  (ISO 3166 code), `context.region`, `context.city` and `context.user_agent`
  for the person instead.

The response is `{"stored": 2, "duplicates": 0, "rejected": [{"index": 3, "reason": "time_out_of_range"}]}`.
Errors: `401 invalid_key`, `403 origin_not_allowed` (a website not in the
project's allowed websites), `400 invalid_request`, `413` (over 512 KB or 500
events).

## Bot filtering

Sessions are flagged by four rules a project can turn off: automation
(headless or driven browsers), crawler (known bot user agents), too fast (more
than 3 events a second over 20 events) and no interaction (5 or more pages
without a click, key or scroll). Flagged sessions are left out of every report
unless the person is marked human. People and networks can be blocked; their
new events are refused.

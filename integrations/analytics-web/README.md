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

After it loads, the same calls are methods: `kma.track(…)`, `kma.revenue(…)`,
`kma.identify(…)`, `kma.setTraits(…)`, `kma.page()`, `kma.reset()`, `kma.optOut()`,
`kma.optIn()`, `kma.flush()`.

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

### Where visitors came from (attribution)

Each visit keeps its landing page's UTM tags, the click ID of a KissMyApps link
(`kma_lc`), the click ID of a creator's affiliate link (`kma_click`) and the ad
platforms' click IDs (`gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`,
`msclkid`). Arriving from a new ad or link starts a new
visit, so each visit has one source. When the project has attribution on, the
console's **Attribution > Sources** report credits each conversion to the last
visit with a source in the website window (30 days by default), or to the
person's first.

The SDK also keeps the visitor's first and last source in `localStorage` for
30 days:

```js
kma.attribution() // { first: { source, campaign, click, landing, at, … }, last: { … } } or null

// A "Get the app" link that carries the source into the app install:
kma.appLink('https://speaksix.go.kissmyapps.dev/app')
// or mark the link and the SDK adds it on click:
// <a data-kma-app-link href="https://speaksix.go.kissmyapps.dev/app">Get the app</a>
```

`appLink` adds `src`, `cmp`, `chn` and `ad` from the last source (unless the
link sets them), the link click that brought the visitor (`kma_from`) and their
anonymous ID (`kma_aid`).

Keeping a visitor's ad source in their browser needs consent in the EU and UK.
`data-attribution="session"` (or `attribution: 'session'` in `init`) reads
sources but keeps them only for the visit and leaves out `kma_aid`;
`data-attribution="off"` reads no click IDs at all. `optOut()` forgets them.

### Crediting creator sales (affiliate program)

A creator's link sends the visitor to your landing page with `kma_click` on the
address. The SDK keeps it with the visit's source for 30 days and sends it with
the visit. To credit a sale, pass it to Stripe when you create the payment:

```js
// In the browser, when the buyer starts checkout. Null when no creator sent them.
const kmaClick = window.kma?.getClickId?.() ?? null
await fetch('/api/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ plan: 'annual', kmaClick }),
})
```

```js
// On your server, with a PaymentIntent
await stripe.paymentIntents.create({
  amount: 5000,
  currency: 'usd',
  metadata: kmaClick ? { kma_click: kmaClick } : {},
})

// or with a Checkout Session
await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_…', quantity: 1 }],
  success_url: 'https://example.com/thanks',
  metadata: kmaClick ? { kma_click: kmaClick } : {},
})
```

Where you cannot set metadata, such as a Payment Link, use
`client_reference_id: 'kma_' + kmaClick` instead.

`kma.getClickId()` returns the click of the visitor's last source, or of their
first source when the last had none. It answers at once from memory and returns
`null` when there is no creator click, before `init`, when the browser blocks
storage and the visitor has moved to another page, after `optOut()`, and with
`data-attribution="off"`. With `data-attribution="session"` the click lasts for
the visit only. The `window.kma?.getClickId?.()` form above also covers a
visitor whose browser blocked the script, so checkout never fails because of it.
A value that is not a KissMyApps click ID (16 to 128 letters, numbers, `_` or
`-`) is ignored.

### Revenue

Record each payment once it has gone through, so the console can show what the people
from each ad or link paid and the return on what you spent:

```js
// The amount in major units (59.99, not 5999) and its ISO 4217 currency code
kma.revenue(59.99, 'USD', { productId: 'annual', transactionId: 'pi_3Q8xLm…' })

// A refund is a negative amount, with the same transaction ID
kma.revenue(-59.99, 'USD', { transactionId: 'pi_3Q8xLm…' })

// Before the script has loaded, like every other call
kma('revenue', 59.99, 'USD', { productId: 'annual' })
```

It sends a `purchase` event (`refund` for a negative amount) with the reserved properties
`kma_revenue` (the amount), `kma_currency` (sent upper case) and, when given,
`kma_product_id` and `kma_transaction_id`. `event` gives the event your own name, such as
`subscription_started`, and `properties` adds more; the four `kma_` properties always come
from the call itself. An amount that is 0, not a number or over 1,000,000,000 either way,
or a currency that is not three letters, sends nothing and logs a warning in the console.
A product or transaction ID longer than 200 characters is left out. Reports show revenue
in the project's currency, converted with the European Central Bank's daily rates.

**Transaction IDs** make one payment count once. Pass the payment provider's ID for it,
such as the Stripe PaymentIntent ID. The same ID reported again, by your server, by your
app or by a RevenueCat or Adapty webhook, is not counted a second time. Without a
transaction ID each call is a separate payment.

From your server, send the same event with a server key (see the HTTP API below):

```http
POST https://events.kissmyapps.dev/v1/events
Authorization: Bearer kma_sk_live_…
Content-Type: application/json

{
  "user_id": "user-42",
  "events": [
    {
      "name": "purchase",
      "insert_id": "pi_3Q8xLm…",
      "time": "2026-11-13T10:00:00Z",
      "properties": {
        "kma_revenue": 59.99,
        "kma_currency": "USD",
        "kma_product_id": "annual",
        "kma_transaction_id": "pi_3Q8xLm…"
      }
    }
  ]
}
```

Use the user ID you pass to `identify`, so the payment joins the person who came from the
ad. `kma_revenue` must be a JSON number.

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

iOS, Android and React Native apps can use the SDKs in
`integrations/analytics-mobile` and `integrations/analytics-react-native`,
which send this for you. Flutter, games and servers send JSON to the same
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
- An event with the properties `kma_revenue` (a number in major units, negative
  for a refund) and `kma_currency` (ISO 4217) is a payment; see
  [Revenue](#revenue). `kma_product_id` and `kma_transaction_id` are optional.
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KmaClient, SDK_VERSION } from './src/client'
import type { ClientOptions, DeviceInfo, Environment, Storage } from './src/client'
import type { AttributionInfo, AttributionRequest, DeepLink } from './src/attribution'
import { deepLinkFrom, installBody, openBody } from './src/attribution'
import { navigationTracker } from './src/navigation'
import contract from '../analytics-mobile/contract/app-events.json'

const key = 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ'
const minutes = (n: number) => n * 60_000

type Body = {
  anonymous_id: string
  user_id?: string
  traits?: Record<string, unknown>
  session?: { id: string; started_at: string }
  sent_at: string
  context: Record<string, unknown>
  events: {
    name: string
    insert_id: string
    time: string
    screen?: string
    properties: Record<string, unknown>
    user_id: string | null
  }[]
}

const iphone: DeviceInfo = {
  platform: 'ios',
  os_name: 'iOS',
  os_version: '18.1',
  device_type: 'mobile',
  device_model: 'iPhone',
  screen_width: 393,
  screen_height: 852,
  timezone: 'Africa/Lagos',
  language: 'en-NG',
}

/** Storage that answers later, as AsyncStorage does. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: async (name) => data.get(name) ?? null,
    setItem: async (name, value) => {
      data.set(name, value)
    },
  }
}

type Answer = { ok: boolean; status: number; text: () => Promise<string> }
type Call = { path: string; body: Record<string, unknown> }

let clock = Date.parse('2026-10-30T09:59:00.000Z')
let sent: Body[] = []
let answer: () => Promise<Answer>
// The attribution calls, kept apart from event batches.
let calls: Call[] = []
let attributionAnswer: (call: Call) => Promise<Answer>
const clients: KmaClient[] = []

const ok = async () => ({ ok: true, status: 200, text: async () => '{}' })
const json =
  (value: unknown, status = 200) =>
  async () => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify(value),
  })
const organic = json({ matched: false, method: 'organic', deep_link: null })

interface StartEnv {
  device?: DeviceInfo
  native?: (request: AttributionRequest) => Promise<AttributionInfo | null>
  initialLink?: () => Promise<string | null>
}

function start(
  storage: Storage | null,
  options: Partial<ClientOptions> = {},
  extra: StartEnv = {},
) {
  const env: Environment = {
    storage,
    device: () => extra.device ?? iphone,
    sdk: `kma-react-native/${SDK_VERSION}`,
    now: () => clock,
    fetch: async (url, init) => {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`)
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
      const path = url.replace('https://events.kissmyapps.dev', '')
      if (path === '/v1/events') {
        sent.push(JSON.parse(String(init.body)))
        return answer()
      }
      expect(['/v1/attribution/install', '/v1/attribution/open']).toContain(path)
      const call = { path, body: JSON.parse(String(init.body)) }
      calls.push(call)
      return attributionAnswer(call)
    },
    attributionInfo: extra.native,
    initialLink: extra.initialLink,
  }
  const client = new KmaClient({ key, appVersion: '2.4.0', build: '120', ...options }, env)
  clients.push(client)
  return client
}

async function settle(ms = 0) {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(300)
}

const names = (bodies = sent) => bodies.flatMap((body) => body.events.map((event) => event.name))

/** The rules every app SDK is held to, from integrations/analytics-mobile/contract. */
function expectContract(body: Body) {
  const allowed = (rules: { required: string[]; optional?: string[] }) => [
    ...rules.required,
    ...(rules.optional ?? []),
  ]
  for (const field of contract.body.required) expect(body).toHaveProperty(field)
  for (const field of Object.keys(body)) expect(allowed(contract.body)).toContain(field)
  for (const field of contract.session.required) expect(body.session).toHaveProperty(field)
  for (const field of contract.context.required) expect(body.context).toHaveProperty(field)
  for (const field of Object.keys(body.context)) expect(allowed(contract.context)).toContain(field)
  expect(contract.platforms).toContain(body.context.platform)
  expect(contract.device_types).toContain(body.context.device_type)
  expect(body.sent_at).toMatch(new RegExp(contract.time))
  for (const event of body.events) {
    for (const field of contract.event.required) expect(event).toHaveProperty(field)
    for (const field of Object.keys(event)) expect(allowed(contract.event)).toContain(field)
    expect(event.name).toMatch(new RegExp(contract.event_name))
    expect(event.time).toMatch(new RegExp(contract.time))
  }
}

const rules = contract.attribution

/** The longest a field may be, from its rule's words ("at most 2048 characters"). */
function longest(rule: string): number {
  const match = /at most (\d+) characters/.exec(rule)
  if (!match) throw new Error(`No length in: ${rule}`)
  return Number(match[1])
}

/** The rules for both attribution calls, from the contract's attribution section. */
function expectAttributionContract(kind: 'install' | 'open', body: Record<string, unknown>) {
  const call = rules[kind]
  const fields = rules.fields as Record<string, unknown>
  for (const field of call.required) expect(body).toHaveProperty(field)
  for (const field of Object.keys(body)) {
    expect([...call.required, ...call.optional]).toContain(field)
  }
  expect(rules.fields.platform).toContain(body.platform)
  expect(typeof body.anonymous_id).toBe('string')
  expect(typeof body.session_id).toBe('string')
  expect(body.sdk).toMatch(/^kma-[a-z-]+\/\d+\.\d+\.\d+$/)
  for (const time of ['installed_at', 'opened_at']) {
    if (time in body) expect(body[time]).toMatch(new RegExp(String(fields[time])))
  }
  for (const pattern of ['device_key', 'clipboard_click']) {
    if (pattern in body) expect(body[pattern]).toMatch(new RegExp(String(fields[pattern])))
  }
  for (const link of ['link_url', 'url']) {
    if (!(link in body)) continue
    expect(body[link]).toMatch(/^https:\/\//)
    expect(String(body[link]).length).toBeLessThanOrEqual(longest(String(fields[link])))
  }
  if ('referrer' in body) {
    expect(String(body.referrer).length).toBeLessThanOrEqual(longest(rules.fields.referrer))
  }
  if ('apple_ads_token' in body) {
    expect(String(body.apple_ads_token).length).toBeLessThanOrEqual(
      longest(rules.fields.apple_ads_token),
    )
  }
  for (const stamp of ['referrer_click_ts', 'install_begin_ts']) {
    if (stamp in body) expect(Number.isInteger(body[stamp])).toBe(true)
  }
  // Android only, and iOS only.
  for (const field of ['referrer', 'referrer_click_ts', 'install_begin_ts']) {
    if (field in body) expect(body.platform).toBe('android')
  }
  for (const field of ['apple_ads_token', 'clipboard_click']) {
    if (field in body) expect(body.platform).toBe('ios')
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = Date.parse('2026-10-30T09:59:00.000Z')
  sent = []
  answer = ok
  calls = []
  attributionAnswer = () => organic()
})

afterEach(() => {
  for (const client of clients.splice(0)) client.shutdown()
  vi.useRealTimers()
})

describe('React Native client', () => {
  it('records the install, the open, screens and events, and sends them on backgrounding', async () => {
    const client = start(memoryStorage())
    await client.ready
    client.foreground()
    client.screen('Home')
    await settle(1000)
    client.screen('Lesson')
    client.track('lesson_completed', { lesson: 3 })
    await settle(63_000)
    client.background()
    await settle()

    expect(names()).toEqual([
      'session_started',
      'app_installed',
      'app_opened',
      'screen_viewed',
      'screen_viewed',
      'lesson_completed',
      'app_backgrounded',
    ])
    const events = sent.flatMap((body) => body.events)
    expect(events[1].properties).toEqual({ version: '2.4.0', build: '120' })
    expect(events[2].properties).toEqual({ from_background: false })
    expect(events[4]).toMatchObject({
      screen: 'Lesson',
      properties: { name: 'Lesson', previous: 'Home' },
    })
    expect(events[5]).toMatchObject({ screen: 'Lesson', properties: { lesson: 3 } })
    expect(events[6].properties).toEqual({ seconds_in_foreground: 64 })
    for (const body of sent) {
      expectContract(body)
      expect(body.session?.id).toBe(client.getSessionId())
      expect(body.context).toMatchObject({
        platform: 'ios',
        sdk: 'kma-react-native/1.1.0',
        app_version: '2.4.0',
        page_path: 'Home',
        device_model: 'iPhone',
      })
    }
  })

  it('tells an update from an install, and keeps the person and a recent session', async () => {
    const storage = memoryStorage()
    const first = start(storage)
    first.foreground()
    await settle()
    first.background()
    await settle()
    const person = first.getAnonymousId()
    const session = first.getSessionId()
    first.shutdown()
    sent = []

    clock += minutes(5)
    const second = start(storage, { appVersion: '2.5.0', build: '130' })
    second.foreground()
    await settle(10_000)
    expect(names()).toEqual(['app_updated', 'app_opened'])
    expect(sent[0].events[0].properties).toEqual({
      version: '2.5.0',
      build: '130',
      previous_version: '2.4.0',
      previous_build: '120',
    })
    expect(second.getAnonymousId()).toBe(person)
    expect(second.getSessionId()).toBe(session)
  })

  it('starts a new session after 30 minutes away', async () => {
    const client = start(memoryStorage())
    client.foreground()
    await settle()
    const first = client.getSessionId()
    client.background()
    await settle()
    sent = []

    clock += minutes(10)
    client.foreground()
    await settle(10_000)
    expect(names()).toEqual(['app_opened'])
    expect(sent[0].events[0].properties).toEqual({ from_background: true })
    expect(client.getSessionId()).toBe(first)
    client.background()
    await settle()
    sent = []

    clock += minutes(31)
    client.foreground()
    await settle(10_000)
    expect(names()).toEqual(['session_started', 'app_opened'])
    expect(client.getSessionId()).not.toBe(first)
  })

  it('keeps events offline, retries, and sends them on a later launch', async () => {
    const storage = memoryStorage()
    answer = async () => {
      throw new Error('offline')
    }
    const client = start(storage, { maxQueue: 4 })
    client.foreground()
    for (const lesson of [1, 2, 3]) client.track('lesson_completed', { lesson })
    client.background()
    await settle(2000)
    expect(sent.length).toBeGreaterThan(0)
    client.shutdown()

    // Only the newest four were kept.
    sent = []
    answer = ok
    const later = start(storage)
    await settle(100)
    const delivered = sent.flatMap((body) => body.events)
    expect(delivered.map((event) => event.name)).toEqual([
      'lesson_completed',
      'lesson_completed',
      'lesson_completed',
      'app_backgrounded',
    ])
    expect(delivered.map((event) => event.properties.lesson)).toEqual([1, 2, 3, undefined])
    expect(later.getAnonymousId()).toBe(client.getAnonymousId())
  })

  it('drops a batch the server refuses but retries when it is busy', async () => {
    // The install call sends what is queued at once; this test times the batches itself.
    const client = start(memoryStorage(), { attribution: false })
    answer = async () => ({ ok: false, status: 503, text: async () => 'busy' })
    client.foreground()
    await settle(10_000)
    expect(sent).toHaveLength(1)
    answer = ok
    await settle(2000)
    expect(sent).toHaveLength(2)
    expect(sent[1].events.map((event) => event.insert_id)).toEqual(
      sent[0].events.map((event) => event.insert_id),
    )

    answer = async () => ({ ok: false, status: 400, text: async () => 'bad' })
    client.track('broken_event')
    await settle(10_000)
    answer = ok
    await settle(60_000)
    expect(names(sent.slice(2))).toEqual(['broken_event'])
  })

  it('names the person once identified, and starts someone new on reset', async () => {
    const client = start(memoryStorage())
    client.foreground()
    client.identify('user-42', { email: 'amaka@example.com', plan: 'annual' })
    await settle()
    expect(sent[0]).toMatchObject({
      user_id: 'user-42',
      traits: { email: 'amaka@example.com', plan: 'annual' },
    })
    client.track('plan_selected')
    await settle(10_000)
    expect(sent[1].user_id).toBe('user-42')
    expect(sent[1].traits).toBeUndefined()

    const before = client.getAnonymousId()
    client.track('signed_out')
    client.reset()
    client.track('browsed')
    await settle(10_000)
    const after = sent.slice(2)
    expect(after[0]).toMatchObject({ anonymous_id: before, user_id: 'user-42' })
    expect(after[0].events.map((event) => event.name)).toEqual(['signed_out'])
    expect(after[1].anonymous_id).not.toBe(before)
    expect(after[1].user_id).toBeUndefined()
    expect(after[1].events.map((event) => event.name)).toEqual(['session_started', 'browsed'])
  })

  it('stays quiet after opting out, across launches, until opting in', async () => {
    const storage = memoryStorage()
    const client = start(storage)
    client.optOut()
    client.foreground()
    client.track('hidden')
    await settle(10_000)
    expect(sent).toHaveLength(0)
    client.shutdown()

    const next = start(storage)
    next.foreground()
    next.track('still_hidden')
    await settle(10_000)
    expect(sent).toHaveLength(0)
    next.optIn()
    next.track('visible')
    await settle(10_000)
    expect(names()).toEqual(['session_started', 'visible'])
  })

  it('keeps calls made before saved state has loaded', async () => {
    let release: () => void = () => undefined
    const loaded = new Promise<void>((resolve) => (release = resolve))
    const slow: Storage = {
      getItem: async () => {
        await loaded
        return null
      },
      setItem: async () => undefined,
    }
    const client = start(slow)
    client.foreground()
    client.screen('Welcome')
    client.track('tapped_start')
    await settle()
    expect(sent).toHaveLength(0)
    release()
    await settle(10_000)
    expect(names()).toEqual([
      'session_started',
      'app_installed',
      'app_opened',
      'screen_viewed',
      'tapped_start',
    ])
  })

  it('keeps an open app online with a heartbeat', async () => {
    const client = start(memoryStorage())
    client.foreground()
    await settle(10_000)
    sent = []
    await settle(60_000)
    expect(sent).toHaveLength(1)
    expect(sent[0].events).toEqual([])
    expect(sent[0].session?.id).toBe(client.getSessionId())
    client.background()
    await settle()
    sent = []
    await settle(120_000)
    expect(sent).toHaveLength(0)
  })

  it('refuses a server key and ignores bad event names', async () => {
    expect(() => start(null, { key: 'kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZ' })).toThrow(/kma_pk_/)
    const client = start(null, { trackLifecycle: false })
    client.foreground()
    client.track('not valid!')
    client.track('valid_name')
    await settle(10_000)
    expect(names()).toEqual(['session_started', 'valid_name'])
  })
})

describe('React Navigation helper', () => {
  it('reports each new screen once', () => {
    const route = { current: 'Home' as string | undefined }
    const screens: string[] = []
    const tracker = navigationTracker(
      { getCurrentRoute: () => (route.current ? { name: route.current } : undefined) },
      (name) => screens.push(name),
    )
    tracker.onReady()
    tracker.onStateChange()
    route.current = 'Lesson'
    tracker.onStateChange()
    route.current = undefined
    tracker.onStateChange()
    route.current = 'Home'
    tracker.onStateChange()
    expect(screens).toEqual(['Home', 'Lesson', 'Home'])
  })
})

const pixel: DeviceInfo = {
  ...iphone,
  platform: 'android',
  os_name: 'Android',
  os_version: '15',
  device_model: 'Pixel 8',
}
const deviceKey = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const playInfo: AttributionInfo = {
  deviceKey,
  referrer: 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok&utm_campaign=launch',
  referrerClickTs: 1761818300,
  installBeginTs: 1761818320,
}
const deferred = json(rules.examples.response)
const installs = () => calls.filter((call) => call.path === '/v1/attribution/install')
const opens = () => calls.filter((call) => call.path === '/v1/attribution/open')

describe('Install attribution and deep links', () => {
  it('matches the contract and its examples', () => {
    expectAttributionContract('install', rules.examples.install)
    expectAttributionContract('open', rules.examples.open)
    const example = rules.examples.install
    expect(
      installBody({
        anonymousId: example.anonymous_id,
        sessionId: example.session_id,
        platform: 'android',
        installedAt: Date.parse(example.installed_at),
        sdk: example.sdk,
        appVersion: example.app_version,
        info: playInfo,
        clipboard: false,
      }),
    ).toEqual({ ...example, referrer: playInfo.referrer })
    const open = rules.examples.open
    expect(
      openBody({
        anonymousId: open.anonymous_id,
        sessionId: open.session_id,
        platform: 'ios',
        url: open.url,
        openedAt: Date.parse(open.opened_at),
        sdk: open.sdk,
        userId: open.user_id,
      }),
    ).toEqual(open)
    for (const field of rules.response.required)
      expect(rules.examples.response).toHaveProperty(field)
    expect(rules.response.methods).toContain(rules.examples.response.method)
    expect(deepLinkFrom(rules.examples.response, null)).toEqual({
      ...rules.examples.response.deep_link,
      url: null,
    })
    expect(deepLinkFrom({ matched: false, method: 'off', deep_link: null }, null)).toBeNull()
  })

  it('calls install once after app_installed, with the Play referrer, and hands over the deep link once', async () => {
    const storage = memoryStorage()
    const asked: AttributionRequest[] = []
    attributionAnswer = deferred
    const client = start(
      storage,
      {},
      {
        device: pixel,
        native: async (request) => {
          asked.push(request)
          return playInfo
        },
      },
    )
    const links: DeepLink[] = []
    client.onDeepLink((link) => links.push(link))
    client.foreground()
    await settle()

    // app_installed and its session went first.
    expect(names()).toEqual(['session_started', 'app_installed', 'app_opened'])
    expect(installs()).toHaveLength(1)
    expect(opens()).toHaveLength(0)
    expect(asked).toEqual([{ install: true, clipboard: false }])
    const body = installs()[0].body
    expectAttributionContract('install', body)
    expect(body).toEqual({
      anonymous_id: client.getAnonymousId(),
      session_id: client.getSessionId(),
      platform: 'android',
      installed_at: '2026-10-30T09:59:00.000Z',
      sdk: 'kma-react-native/1.1.0',
      app_version: '2.4.0',
      device_key: deviceKey,
      referrer: playInfo.referrer,
      referrer_click_ts: 1761818300,
      install_begin_ts: 1761818320,
    })
    expect(links).toEqual([{ value: 'lesson', params: { id: '4' }, deferred: true, url: null }])

    // Later launches make no install call, and the deep link is not handed over again.
    client.background()
    await settle()
    client.shutdown()
    const next = start(storage, {}, { device: pixel, native: async () => playInfo })
    next.onDeepLink((link) => links.push(link))
    next.foreground()
    await settle(10_000)
    expect(installs()).toHaveLength(1)
    expect(links).toHaveLength(1)
  })

  it('sends the Apple Ads token on iPhone, and the clipboard click only when handoff is on', async () => {
    const asked: AttributionRequest[] = []
    const iosInfo: AttributionInfo = {
      deviceKey,
      appleAdsToken: 'A'.repeat(200),
      clipboardClick: 'Q2xpY2tJZDAwMDAwMDAwMQ',
      referrer: 'never sent from an iPhone',
    }
    const native = async (request: AttributionRequest) => {
      asked.push(request)
      return iosInfo
    }
    const plain = start(memoryStorage(), {}, { native })
    plain.foreground()
    await settle()
    const handoff = start(memoryStorage(), { clipboardHandoff: true }, { native })
    handoff.foreground()
    await settle()

    expect(asked).toEqual([
      { install: true, clipboard: false },
      { install: true, clipboard: true },
    ])
    const [first, second] = installs().map((call) => call.body)
    for (const body of [first, second]) expectAttributionContract('install', body)
    expect(first).toMatchObject({ platform: 'ios', apple_ads_token: 'A'.repeat(200) })
    expect(first).not.toHaveProperty('clipboard_click')
    expect(first).not.toHaveProperty('referrer')
    expect(second).toMatchObject({ clipboard_click: 'Q2xpY2tJZDAwMDAwMDAwMQ' })
  })

  it('leaves out what the device gives that the contract does not allow', async () => {
    const client = start(
      memoryStorage(),
      { clipboardHandoff: true },
      {
        native: async () => ({
          deviceKey: 'NOT-A-HASH',
          appleAdsToken: 'A'.repeat(5000),
          clipboardClick: 'too short',
        }),
      },
    )
    client.foreground()
    await settle()
    const body = installs()[0].body
    expectAttributionContract('install', body)
    expect(Object.keys(body).sort()).toEqual([
      'anonymous_id',
      'app_version',
      'installed_at',
      'platform',
      'sdk',
      'session_id',
    ])
  })

  it('still calls install without the native module, and when it fails or hangs', async () => {
    const without = start(memoryStorage())
    without.foreground()
    await settle()
    const failing = start(
      memoryStorage(),
      {},
      {
        native: async () => {
          throw new Error('no referrer service')
        },
      },
    )
    failing.foreground()
    await settle()
    const hanging = start(memoryStorage(), {}, { native: () => new Promise(() => undefined) })
    hanging.foreground()
    await settle(12_000)
    expect(installs()).toHaveLength(3)
    for (const call of installs()) expectAttributionContract('install', call.body)
  })

  it("tries again on the next launches when offline, three times at most, with the first launch's details", async () => {
    const storage = memoryStorage()
    attributionAnswer = async () => {
      throw new Error('offline')
    }
    let client = start(storage, {}, { device: pixel, native: async () => playInfo })
    client.foreground()
    await settle()
    const person = client.getAnonymousId()
    const session = client.getSessionId()
    for (let launch = 2; launch <= 6; launch += 1) {
      client.background()
      await settle()
      client.shutdown()
      clock += minutes(60)
      client = start(storage, {}, { device: pixel, native: async () => playInfo })
      client.foreground()
      await settle()
    }
    expect(installs()).toHaveLength(4)
    for (const call of installs()) {
      expectAttributionContract('install', call.body)
      expect(call.body).toMatchObject({
        anonymous_id: person,
        session_id: session,
        installed_at: '2026-10-30T09:59:00.000Z',
      })
    }
  })

  it('resends the first try as it was, reading again only a referrer that timed out and the Apple Ads token each time', async () => {
    const storage = memoryStorage()
    attributionAnswer = async () => {
      throw new Error('offline')
    }
    const referrer = 'kma_lc=FirstClickId0000001'
    let launch = 1
    const android = () =>
      start(
        storage,
        {},
        {
          device: pixel,
          native: async () => ({ ...playInfo, referrer: `${referrer}-${launch}` }),
        },
      )
    let client = android()
    client.foreground()
    await settle()
    client.shutdown()
    launch = 2
    client = android()
    client.foreground()
    await settle()
    expect(installs().map((call) => call.body.referrer)).toEqual([
      'kma_lc=FirstClickId0000001-1',
      'kma_lc=FirstClickId0000001-1',
    ])

    // Google Play did not answer in time on the first launch: the next one asks again.
    calls = []
    const slow = memoryStorage()
    let answer: AttributionInfo = { deviceKey, retryReferrer: true }
    const late = () => start(slow, {}, { device: pixel, native: async () => answer })
    client = late()
    client.foreground()
    await settle()
    client.shutdown()
    answer = playInfo
    client = late()
    client.foreground()
    await settle()
    expect(installs().map((call) => call.body.referrer ?? null)).toEqual([null, playInfo.referrer])

    // On iPhone the token is fetched for each try (it expires); the clipboard is read once.
    calls = []
    const phone = memoryStorage()
    const asked: AttributionRequest[] = []
    let adsAnswer = 'ads-1'
    const ios = () =>
      start(
        phone,
        { clipboardHandoff: true },
        {
          native: async (request) => {
            asked.push(request)
            return {
              deviceKey,
              appleAdsToken: adsAnswer,
              clipboardClick: request.clipboard ? 'Q2xpY2tJZDAwMDAwMDAwMQ' : null,
            }
          },
        },
      )
    client = ios()
    client.foreground()
    await settle()
    client.shutdown()
    adsAnswer = 'ads-2'
    client = ios()
    client.foreground()
    await settle()
    expect(asked.map((request) => request.clipboard)).toEqual([true, false])
    expect(
      installs().map((call) => [call.body.apple_ads_token, call.body.clipboard_click]),
    ).toEqual([
      ['ads-1', 'Q2xpY2tJZDAwMDAwMDAwMQ'],
      ['ads-2', 'Q2xpY2tJZDAwMDAwMDAwMQ'],
    ])
  })

  it('cuts a long referrer to 1,024 characters and leaves out unknown Play times', async () => {
    const client = start(
      memoryStorage(),
      {},
      {
        device: pixel,
        native: async () => ({ referrer: 'r'.repeat(1500), referrerClickTs: 0, installBeginTs: 0 }),
      },
    )
    client.foreground()
    await settle()
    const body = installs()[0].body
    expectAttributionContract('install', body)
    expect(body.referrer).toBe('r'.repeat(1024))
    expect(body).not.toHaveProperty('referrer_click_ts')
    expect(body).not.toHaveProperty('install_begin_ts')
  })

  it('calls install with lifecycle tracking off, and holds it back while opted out until optIn', async () => {
    const quiet = start(memoryStorage(), { trackLifecycle: false })
    quiet.foreground()
    await settle()
    expect(installs()).toHaveLength(1)

    calls = []
    let release: () => void = () => undefined
    const slow = new Promise<AttributionInfo>((resolve) => (release = () => resolve({ deviceKey })))
    const client = start(memoryStorage(), {}, { native: () => slow })
    client.foreground()
    await settle()
    client.optOut()
    release()
    await settle()
    expect(calls).toHaveLength(0)
    client.optIn()
    await settle()
    expect(installs()).toHaveLength(1)
    expect(installs()[0].body.device_key).toBe(deviceKey)
  })

  it('sends links that came while the install call was out once it is answered, and not before', async () => {
    let answerInstall: (answer: Answer) => void = () => undefined
    attributionAnswer = (call) =>
      call.path === '/v1/attribution/install'
        ? new Promise<Answer>((resolve) => (answerInstall = resolve))
        : organic()
    const client = start(memoryStorage())
    client.foreground()
    client.handleDeepLink('https://fluent.go.kissmyapps.dev/first')
    client.handleDeepLink('https://fluent.go.kissmyapps.dev/second')
    await settle()
    client.handleDeepLink('https://fluent.go.kissmyapps.dev/third')
    await settle()
    expect(calls.map((call) => call.path)).toEqual(['/v1/attribution/install'])
    expect(installs()[0].body.link_url).toBe('https://fluent.go.kissmyapps.dev/first')
    answerInstall(await organic())
    await settle()
    expect(opens().map((call) => call.body.url)).toEqual([
      'https://fluent.go.kissmyapps.dev/second',
      'https://fluent.go.kissmyapps.dev/third',
    ])
  })

  it('on a retry launch, sends a link to open only after the install is answered, never in link_url', async () => {
    const storage = memoryStorage()
    attributionAnswer = async () => {
      throw new Error('offline')
    }
    let client = start(storage)
    client.foreground()
    await settle()
    client.shutdown()

    // Still offline: the link is not sent, or the open would record an install first.
    client = start(
      storage,
      {},
      {
        initialLink: async () => 'https://fluent.go.kissmyapps.dev/again',
      },
    )
    client.foreground()
    await settle()
    client.handleDeepLink('https://fluent.go.kissmyapps.dev/later')
    await settle()
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/attribution/install',
      '/v1/attribution/install',
    ])
    client.shutdown()

    attributionAnswer = () => organic()
    client = start(
      storage,
      {},
      {
        initialLink: async () => 'https://fluent.go.kissmyapps.dev/third-launch',
      },
    )
    client.foreground()
    await settle()
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/attribution/install',
      '/v1/attribution/install',
      '/v1/attribution/install',
      '/v1/attribution/open',
    ])
    for (const call of installs()) expect(call.body).not.toHaveProperty('link_url')
    expect(opens()[0].body.url).toBe('https://fluent.go.kissmyapps.dev/third-launch')
  })

  it('reads at most 10 deep link parameters, as text', () => {
    const params = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`p${index}`, index]),
    )
    const link = deepLinkFrom(
      {
        matched: true,
        method: 'some_new_method',
        deep_link: { value: null, params: { on: true, list: [1], ...params }, deferred: false },
      },
      null,
    )
    expect(link?.params.on).toBe('true')
    expect(link?.params).not.toHaveProperty('list')
    expect(Object.keys(link?.params ?? {})).toHaveLength(10)
    expect(link?.value).toBeNull()
  })

  it('stops trying once the server answers, and does not retry a refused body', async () => {
    const storage = memoryStorage()
    attributionAnswer = json({ error: 'busy' }, 503)
    let client = start(storage)
    client.foreground()
    await settle()
    client.shutdown()
    attributionAnswer = organic
    client = start(storage)
    client.foreground()
    await settle()
    client.shutdown()
    client = start(storage)
    client.foreground()
    await settle()
    expect(installs()).toHaveLength(2)

    const refused = memoryStorage()
    attributionAnswer = json({ error: 'invalid_body' }, 400)
    client = start(refused)
    client.foreground()
    await settle()
    client.shutdown()
    client = start(refused)
    client.foreground()
    await settle()
    expect(installs()).toHaveLength(3)
  })

  it('sends the opening link with the install, and later links to open', async () => {
    attributionAnswer = async (call) =>
      call.path === '/v1/attribution/install'
        ? json({
            matched: true,
            method: 'link_open',
            deep_link: { value: 'lesson', params: { id: '4' }, deferred: true },
          })()
        : json({
            matched: true,
            method: 'link_open',
            deep_link: { value: 'promo', params: { code: 7 }, deferred: false },
          })()
    const opening = 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4'
    const client = start(memoryStorage(), {}, { initialLink: async () => opening })
    const links: DeepLink[] = []
    client.onDeepLink((link) => links.push(link))
    client.foreground()
    // The app reports the same link too: it counts once.
    expect(client.handleDeepLink(opening)).toBe(true)
    await settle()
    expect(opens()).toHaveLength(0)
    expect(installs()[0].body.link_url).toBe(opening)

    clock += 5000
    client.identify('user-42')
    expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/promo')).toBe(true)
    await settle()
    expect(opens()).toHaveLength(1)
    const body = opens()[0].body
    expectAttributionContract('open', body)
    expect(body).toEqual({
      anonymous_id: client.getAnonymousId(),
      session_id: client.getSessionId(),
      platform: 'ios',
      url: 'https://fluent.go.kissmyapps.dev/promo',
      opened_at: '2026-10-30T09:59:05.000Z',
      sdk: 'kma-react-native/1.1.0',
      user_id: 'user-42',
      app_version: '2.4.0',
    })
    expect(links).toEqual([
      { value: 'lesson', params: { id: '4' }, deferred: true, url: opening },
      {
        value: 'promo',
        params: { code: '7' },
        deferred: false,
        url: 'https://fluent.go.kissmyapps.dev/promo',
      },
    ])
  })

  it('keeps a link that came before the launch for the install call', async () => {
    const client = start(memoryStorage())
    expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/lesson-4')).toBe(true)
    await settle()
    expect(calls).toHaveLength(0)
    client.foreground()
    await settle()
    expect(calls.map((call) => call.path)).toEqual(['/v1/attribution/install'])
    expect(installs()[0].body.link_url).toBe('https://fluent.go.kissmyapps.dev/lesson-4')
  })

  it('holds a deep link until a handler is set, and hands it over once', async () => {
    attributionAnswer = deferred
    const client = start(memoryStorage())
    client.foreground()
    await settle()
    const first: DeepLink[] = []
    const second: DeepLink[] = []
    client.onDeepLink((link) => first.push(link))
    await settle()
    client.onDeepLink((link) => second.push(link))
    await settle()
    expect(first).toEqual([{ value: 'lesson', params: { id: '4' }, deferred: true, url: null }])
    expect(second).toEqual([])

    // A handler that throws does not stop the SDK.
    client.onDeepLink(() => {
      throw new Error('navigator not ready')
    })
    attributionAnswer = json({ matched: true, method: 'link_open', deep_link: null })
    client.handleDeepLink('https://fluent.go.kissmyapps.dev/nothing')
    await settle()
    expect(opens()).toHaveLength(1)
  })

  it('sends nothing for other links, when opted out, or with attribution off', async () => {
    const client = start(memoryStorage(), {}, { initialLink: async () => 'fluent://lesson/4' })
    client.foreground()
    await settle()
    expect(client.handleDeepLink('fluent://lesson/4')).toBe(false)
    expect(client.handleDeepLink('http://fluent.go.kissmyapps.dev/a')).toBe(false)
    expect(client.handleDeepLink(`https://fluent.go.kissmyapps.dev/${'a'.repeat(2048)}`)).toBe(
      false,
    )
    client.optOut()
    await settle()
    expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/a')).toBe(false)
    await settle()
    expect(calls.map((call) => call.path)).toEqual(['/v1/attribution/install'])
    expect(installs()[0].body).not.toHaveProperty('link_url')

    calls = []
    const off = start(
      memoryStorage(),
      { attribution: false },
      {
        initialLink: async () => 'https://fluent.go.kissmyapps.dev/a',
      },
    )
    off.foreground()
    expect(off.handleDeepLink('https://fluent.go.kissmyapps.dev/b')).toBe(false)
    await settle()
    expect(calls).toHaveLength(0)

    // Without storage every launch looks like the first: there is no install to match.
    const forgetful = start(null)
    forgetful.foreground()
    await settle()
    expect(calls).toHaveLength(0)
  })
})

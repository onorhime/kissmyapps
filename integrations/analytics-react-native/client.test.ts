import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KmaClient } from './src/client'
import type { ClientOptions, DeviceInfo, Environment, Storage } from './src/client'
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

let clock = Date.parse('2026-10-30T09:59:00.000Z')
let sent: Body[] = []
let answer: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
const clients: KmaClient[] = []

const ok = async () => ({ ok: true, status: 200, text: async () => '{}' })

function start(storage: Storage | null, options: Partial<ClientOptions> = {}) {
  const env: Environment = {
    storage,
    device: () => iphone,
    sdk: 'kma-react-native/1.0.0',
    now: () => clock,
    fetch: async (url, init) => {
      expect(url).toBe('https://events.kissmyapps.dev/v1/events')
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`)
      sent.push(JSON.parse(String(init.body)))
      return answer()
    },
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

beforeEach(() => {
  vi.useFakeTimers()
  clock = Date.parse('2026-10-30T09:59:00.000Z')
  sent = []
  answer = ok
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
        sdk: 'kma-react-native/1.0.0',
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
    const client = start(memoryStorage())
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

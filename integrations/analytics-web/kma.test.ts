import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kma, type KmaOptions } from './src/kma'

const key = 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ'
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
  replay?: { seq: number; first_ts: number; last_ts: number; events: unknown[] }
  api_key?: string
}

let instances: Kma[] = []
let responses: (() => Response | Promise<Response>)[] = []
const sent: { url: string; body: Body; headers: Record<string, string> }[] = []
const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({
    url: String(url),
    body: JSON.parse(String(init?.body)),
    headers: init?.headers as Record<string, string>,
  })
  const next = responses.shift()
  return next ? next() : new Response('{"stored":1}', { status: 200 })
})

function start(options: Partial<KmaOptions> = {}): Kma {
  const kma = new Kma({
    key,
    endpoint: 'https://events.example',
    replay: false,
    fetch: fetchMock as typeof fetch,
    debug: false,
    ...options,
  })
  instances.push(kma)
  return kma
}

const eventsSent = () =>
  sent.filter((s) => s.url.endsWith('/v1/events')).flatMap((s) => s.body.events)

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date('2026-10-30T12:00:00Z'),
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  localStorage.clear()
  sent.length = 0
  responses = []
  fetchMock.mockClear()
  window.history.replaceState(null, '', '/?utm_source=newsletter&utm_campaign=autumn')
})

afterEach(() => {
  for (const kma of instances) kma.shutdown()
  instances = []
  vi.useRealTimers()
})

describe('web SDK', () => {
  it('opens a session, records the landing page and sends one batch', async () => {
    const kma = start({ appVersion: '3.1.0' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [{ url, body, headers }] = sent
    expect(url).toBe('https://events.example/v1/events')
    expect(headers.authorization).toBe(`Bearer ${key}`)
    expect(body.anonymous_id).toBe(kma.getAnonymousId())
    expect(body.session?.id).toBe(kma.getSessionId())
    expect(body.events.map((e) => e.name)).toEqual(['session_started', 'page_viewed'])
    expect(body.events[1]).toMatchObject({ screen: '/', user_id: null })
    expect(body.context).toMatchObject({
      platform: 'web',
      sdk: 'kma-web/1.0.0',
      app_version: '3.1.0',
      page_path: '/',
      utm: { source: 'newsletter', campaign: 'autumn' },
      webdriver: false,
    })
    expect(typeof body.context.timezone).toBe('string')
  })

  it('refuses invalid event names without sending them', async () => {
    const kma = start({ autoPageViews: false })
    kma.track('bad name!')
    kma.track('plan_selected', { plan: 'annual' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(eventsSent().map((e) => e.name)).toEqual(['session_started', 'plan_selected'])
    expect(eventsSent()[1].properties).toEqual({ plan: 'annual' })
  })

  it('names the user on later events and sends traits once', async () => {
    const kma = start({ autoPageViews: false })
    await vi.advanceTimersByTimeAsync(2000)
    kma.identify(42, { email: 'amaka@example.com' })
    await vi.advanceTimersByTimeAsync(10)
    // Nothing was queued, so identify goes out on its own.
    expect(sent[1].body).toMatchObject({
      user_id: '42',
      traits: { email: 'amaka@example.com' },
      events: [],
    })
    kma.track('lesson_completed')
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent[2].body.user_id).toBe('42')
    expect(sent[2].body.traits).toBeUndefined()
    expect(sent[2].body.events[0].user_id).toBe('42')
  })

  it('starts a new session after 30 idle minutes', async () => {
    const kma = start({ autoPageViews: false })
    const first = kma.getSessionId()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    kma.track('came_back')
    await vi.advanceTimersByTimeAsync(2000)
    expect(kma.getSessionId()).not.toBe(first)
    const last = sent.at(-1)!.body
    expect(last.session?.id).toBe(kma.getSessionId())
    expect(last.events.map((e) => e.name)).toEqual(['session_started', 'came_back'])
  })

  it('keeps events through network failures and resends them unchanged', async () => {
    responses = [
      () => Promise.reject(new TypeError('offline')),
      () => new Response('', { status: 503 }),
    ]
    const kma = start({ autoPageViews: false })
    kma.track('plan_selected')
    await vi.advanceTimersByTimeAsync(2000)
    expect(JSON.parse(localStorage.getItem(`kma:${key.slice(-8)}:queue`)!)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(sent).toHaveLength(3)
    expect(sent[2].body.events.map((e) => e.insert_id)).toEqual(
      sent[0].body.events.map((e) => e.insert_id),
    )
    expect(JSON.parse(localStorage.getItem(`kma:${key.slice(-8)}:queue`)!)).toHaveLength(0)
  })

  it('drops a batch the server refuses', async () => {
    responses = [() => new Response('{"error":"invalid_key"}', { status: 401 })]
    start({ autoPageViews: false })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.filter((s) => s.body.events.length)).toHaveLength(1)
  })

  it('records single-page navigation, hash routes and errors', async () => {
    start()
    window.history.pushState(null, '', '/pricing')
    await Promise.resolve()
    window.history.pushState(null, '', '/pricing')
    await Promise.resolve()
    window.location.hash = '#/plans'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Audio failed', filename: 'app.js', lineno: 3, colno: 9 }),
    )
    await vi.advanceTimersByTimeAsync(2000)
    const events = eventsSent()
    expect(events.filter((e) => e.name === 'page_viewed').map((e) => e.screen)).toEqual([
      '/',
      '/pricing',
      '/pricing#/plans',
    ])
    expect(events.find((e) => e.name === 'error_thrown')?.properties).toMatchObject({
      message: 'Audio failed',
      line: 3,
      column: 9,
    })
  })

  it('counts interactions for bot detection', async () => {
    start({ autoPageViews: false })
    window.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent[0].body.context.interactions).toBe(2)
  })

  it('keeps queued events with the person who did them when reset', async () => {
    const kma = start({ autoPageViews: false })
    kma.identify('user-1')
    kma.track('signed_out')
    const before = kma.getAnonymousId()
    responses = [() => Promise.reject(new TypeError('offline'))]
    await vi.advanceTimersByTimeAsync(0)
    kma.reset()
    expect(kma.getAnonymousId()).not.toBe(before)
    expect(kma.getUserId()).toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    const bodies = sent.slice(1).map((s) => s.body)
    const old = bodies.find((b) => b.events.some((e) => e.name === 'signed_out'))!
    expect(old.anonymous_id).toBe(before)
    expect(old.user_id).toBe('user-1')
    expect(old.traits).toBeUndefined()
    const fresh = bodies.find((b) => b.anonymous_id === kma.getAnonymousId())!
    expect(fresh.user_id).toBeUndefined()
    expect(fresh.events.map((e) => e.name)).toEqual(['session_started'])
  })

  it('hands queued events to sendBeacon when the page is hidden', async () => {
    const beacon = vi.fn((_url: string, _data: Blob) => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    start({ autoPageViews: false }).track('checkout_left')
    window.dispatchEvent(new Event('pagehide'))
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, blob] = beacon.mock.calls[0]
    expect(url).toBe('https://events.example/v1/events')
    expect(blob.type).toBe('text/plain')
    const body = JSON.parse(await blob.text()) as Body
    expect(body.api_key).toBe(key)
    expect(body.events.map((e) => e.name)).toEqual(['session_started', 'checkout_left'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a heartbeat while the page stays open', async () => {
    start({ autoPageViews: false })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(2)
    expect(sent[1].body.events).toEqual([])
    expect(sent[1].body.session?.id).toBe(sent[0].body.session?.id)
  })

  it('sends nothing after opting out', async () => {
    const kma = start({ autoPageViews: false })
    kma.optOut()
    kma.track('anything')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads replay chunks for the session and stops when replay is off', async () => {
    let emit: (event: { timestamp: number; type: number }) => void = () => undefined
    const stop = vi.fn()
    const loadReplay = vi.fn(async () => ({
      start(callback: typeof emit) {
        emit = callback
        return { stop, takeFullSnapshot: vi.fn() }
      },
    }))
    const kma = start({ autoPageViews: false, replay: true, loadReplay })
    await vi.advanceTimersByTimeAsync(0)
    const t0 = Date.now()
    emit({ type: 4, timestamp: t0 + 10 })
    emit({ type: 2, timestamp: t0 + 12 })
    await vi.advanceTimersByTimeAsync(5000)
    const chunk = sent.find((s) => s.url.endsWith('/v1/replay'))!
    expect(chunk.body.session?.id).toBe(kma.getSessionId())
    expect(chunk.body.replay).toEqual({
      seq: 10,
      first_ts: t0 + 10,
      last_ts: t0 + 12,
      events: [
        { type: 4, timestamp: t0 + 10 },
        { type: 2, timestamp: t0 + 12 },
      ],
    })

    responses = [() => new Response('{"error":"replay_disabled"}', { status: 409 })]
    emit({ type: 3, timestamp: Date.now() })
    await vi.advanceTimersByTimeAsync(5000)
    expect(stop).toHaveBeenCalled()
    const saved = JSON.parse(localStorage.getItem(`kma:${key.slice(-8)}`)!)
    expect(saved.replayOffUntil).toBeGreaterThan(Date.now())
  })

  it('needs a client key', () => {
    expect(() => new Kma({ key: 'kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpq' })).toThrow(
      /client key/,
    )
  })
})

describe('script tag build', () => {
  it('runs calls made before the script loaded', async () => {
    vi.resetModules()
    const stub = Object.assign(() => undefined, {
      q: [
        [
          'init',
          key,
          {
            endpoint: 'https://events.example',
            replay: false,
            fetch: fetchMock,
            debug: false,
            autoPageViews: false,
          },
        ],
        ['track', 'early_event', { from: 'stub' }],
      ],
    })
    ;(window as unknown as { kma: unknown }).kma = stub
    await import('./src/global')
    const api = (window as unknown as { kma: { instance: Kma; track(name: string): void } }).kma
    expect(api.instance.getAnonymousId()).toMatch(/^[0-9a-f-]{36}$/)
    instances.push(api.instance)
    api.track('late_event')
    await vi.advanceTimersByTimeAsync(2000)
    expect(eventsSent().map((e) => e.name)).toEqual([
      'session_started',
      'early_event',
      'late_event',
    ])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kma, type KmaOptions, type Properties, type RevenueOptions } from './src/kma'
import contract from '../analytics-mobile/contract/app-events.json'

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
      sdk: 'kma-web/1.2.0',
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

  it('sends the first snapshot within a second and beacons the rest on page hide', async () => {
    const beacon = vi.fn((_url: string, _data: Blob) => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    let emit: (event: { timestamp: number; type: number }) => void = () => undefined
    const loadReplay = vi.fn(async () => ({
      start(callback: typeof emit) {
        emit = callback
        return { stop: vi.fn(), takeFullSnapshot: vi.fn() }
      },
    }))
    const kma = start({ autoPageViews: false, replay: true, loadReplay })
    await vi.advanceTimersByTimeAsync(0)
    emit({ type: 4, timestamp: Date.now() })
    emit({ type: 2, timestamp: Date.now() })
    await vi.advanceTimersByTimeAsync(1000)
    const first = sent.filter((s) => s.url.endsWith('/v1/replay'))
    expect(first).toHaveLength(1)
    expect(first[0].body.replay?.events).toHaveLength(2)

    emit({ type: 3, timestamp: Date.now() })
    kma.track('left_quickly')
    window.dispatchEvent(new Event('pagehide'))
    const replayBeacon = beacon.mock.calls.find(([url]) => url.endsWith('/v1/replay'))!
    expect(replayBeacon[1].type).toBe('text/plain')
    const body = JSON.parse(await replayBeacon[1].text()) as Body
    expect(body.api_key).toBe(key)
    expect(body.replay?.events).toEqual([{ type: 3, timestamp: Date.now() }])
    // Events go first: they share the browser's allowance for page hide with the replay.
    expect(beacon.mock.calls[0][0]).toBe('https://events.example/v1/events')
  })

  it('needs a client key', () => {
    expect(() => new Kma({ key: 'kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpq' })).toThrow(
      /client key/,
    )
  })
})

describe('attribution', () => {
  it("sends the landing page's link click and ad click IDs with the visit", async () => {
    window.history.replaceState(
      null,
      '',
      '/start?kma_lc=Lk9x2mQ4rT7vW1yZ3bC5dE&fbclid=IwAR1&utm_source=tiktok',
    )
    const kma = start({ autoPageViews: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent[0].body.context).toMatchObject({
      utm: { source: 'tiktok' },
      click: { kma_lc: 'Lk9x2mQ4rT7vW1yZ3bC5dE', fbclid: 'IwAR1' },
    })
    expect(kma.attribution()).toMatchObject({
      first: { source: 'tiktok', click: { kma_lc: 'Lk9x2mQ4rT7vW1yZ3bC5dE' }, landing: '/start' },
      last: { source: 'tiktok' },
    })
  })

  it('keeps the first source, moves the last, and starts a new visit for a new ad', async () => {
    const first = start({ autoPageViews: false })
    const firstSession = first.getSessionId()
    first.shutdown()
    // Same tags again within the visit: the same visit.
    expect(start({ autoPageViews: false }).getSessionId()).toBe(firstSession)
    vi.advanceTimersByTime(60_000)
    window.history.replaceState(null, '', '/?utm_source=facebook&utm_campaign=launch&gclid=Cj0')
    const second = start({ autoPageViews: false })
    expect(second.getSessionId()).not.toBe(firstSession)
    expect(second.attribution()).toMatchObject({
      first: { source: 'newsletter', campaign: 'autumn' },
      last: { source: 'facebook', campaign: 'launch', click: { gclid: 'Cj0' } },
    })
  })

  it('forgets sources after 30 days', () => {
    start({ autoPageViews: false }).shutdown()
    vi.advanceTimersByTime(31 * 24 * 60 * 60_000)
    window.history.replaceState(null, '', '/')
    expect(start({ autoPageViews: false }).attribution()).toBeNull()
  })

  it('builds app links that carry the source, and rewrites marked links on click', () => {
    window.history.replaceState(
      null,
      '',
      '/?utm_source=facebook&utm_campaign=launch&utm_content=video&kma_lc=Lk9x2mQ4rT7vW1yZ3bC5dE',
    )
    const kma = start({ autoPageViews: false })
    const url = new URL(kma.appLink('https://speaksix.go.kissmyapps.dev/app?cmp=keep'))
    expect(url.searchParams.get('src')).toBe('facebook')
    expect(url.searchParams.get('cmp')).toBe('keep')
    expect(url.searchParams.get('ad')).toBe('video')
    expect(url.searchParams.get('kma_from')).toBe('Lk9x2mQ4rT7vW1yZ3bC5dE')
    expect(url.searchParams.get('kma_aid')).toBe(kma.getAnonymousId())
    expect(kma.appLink('not a url ::')).toContain('not')
    const anchor = document.createElement('a')
    anchor.href = 'https://speaksix.go.kissmyapps.dev/app'
    anchor.dataset.kmaAppLink = ''
    anchor.addEventListener('click', (event) => event.preventDefault())
    document.body.appendChild(anchor)
    anchor.click()
    expect(new URL(anchor.href).searchParams.get('src')).toBe('facebook')
    anchor.click()
    expect(anchor.href.match(/src=/g)).toHaveLength(1)
    anchor.remove()
  })

  it('keeps sources for the visit only in session mode, and reads none when off', async () => {
    window.history.replaceState(null, '', '/?utm_source=tiktok&gclid=Cj0')
    const session = start({ autoPageViews: false, attribution: 'session' })
    expect(session.attribution()?.last.source).toBe('tiktok')
    expect(new URL(session.appLink('https://l.example/x')).searchParams.get('kma_aid')).toBeNull()
    expect(Object.keys(localStorage).some((k) => k.endsWith(':touch'))).toBe(false)
    session.shutdown()
    localStorage.clear()
    const off = start({ autoPageViews: false, attribution: 'off' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)?.body.context.click).toBeUndefined()
    expect(off.attribution()).toBeNull()
    expect(off.appLink('https://l.example/x')).toBe('https://l.example/x')
  })

  it('forgets sources on opt out', () => {
    const kma = start({ autoPageViews: false })
    expect(kma.attribution()).not.toBeNull()
    kma.optOut()
    expect(kma.attribution()).toBeNull()
    expect(Object.keys(localStorage).some((k) => k.endsWith(':touch'))).toBe(false)
  })
})

describe('creator click', () => {
  const click = 'kc_7Hq2mW9xLp4RtZ8vB3nD'
  const other = 'kc_Zz91AbCdEfGhIjKlMnOp'

  it('reads kma_click from the landing page, sends it with the visit and returns it', async () => {
    window.history.replaceState(null, '', `/start?kma_click=${click}&utm_source=creator`)
    const kma = start({ autoPageViews: false })
    expect(kma.getClickId()).toBe(click)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent[0].body.context.click).toEqual({ kma_click: click })
    expect(kma.attribution()?.last.click).toEqual({ kma_click: click })
    // The address keeps the parameter, as it does for the other click IDs.
    expect(window.location.search).toContain(`kma_click=${click}`)
    kma.shutdown()
    // A later page of the same site, days later: the click is still there.
    vi.advanceTimersByTime(3 * 24 * 60 * 60_000)
    window.history.replaceState(null, '', '/checkout')
    expect(start({ autoPageViews: false }).getClickId()).toBe(click)
  })

  it('ignores a kma_click that is not a click ID', async () => {
    for (const bad of ['short', 'has spaces in the value', `${click}<script>`, 'x'.repeat(129)]) {
      localStorage.clear()
      window.history.replaceState(null, '', `/?kma_click=${encodeURIComponent(bad)}&gclid=Cj0`)
      const kma = start({ autoPageViews: false })
      expect(kma.getClickId()).toBeNull()
      expect(kma.attribution()?.last.click).toEqual({ gclid: 'Cj0' })
      kma.shutdown()
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.every((s) => !('kma_click' in ((s.body.context.click as object) ?? {})))).toBe(true)
  })

  it('returns the last click, or the first when the last visit had none', () => {
    window.history.replaceState(null, '', `/?kma_click=${click}`)
    start({ autoPageViews: false }).shutdown()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    window.history.replaceState(null, '', '/?utm_source=google&gclid=Cj0')
    const fromAd = start({ autoPageViews: false })
    expect(fromAd.attribution()?.last.click).toEqual({ gclid: 'Cj0' })
    expect(fromAd.getClickId()).toBe(click)
    fromAd.shutdown()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    window.history.replaceState(null, '', `/?kma_click=${other}`)
    const second = start({ autoPageViews: false })
    expect(second.getSessionId()).not.toBe(fromAd.getSessionId())
    expect(second.getClickId()).toBe(other)
  })

  it('forgets the click after 30 days, on opt out and when attribution is off', () => {
    window.history.replaceState(null, '', `/?kma_click=${click}`)
    const kma = start({ autoPageViews: false })
    kma.optOut()
    expect(kma.getClickId()).toBeNull()
    kma.shutdown()
    localStorage.clear()
    start({ autoPageViews: false }).shutdown()
    vi.advanceTimersByTime(31 * 24 * 60 * 60_000)
    window.history.replaceState(null, '', '/')
    expect(start({ autoPageViews: false }).getClickId()).toBeNull()
    localStorage.clear()
    window.history.replaceState(null, '', `/?kma_click=${click}`)
    expect(start({ autoPageViews: false, attribution: 'off' }).getClickId()).toBeNull()
  })

  it('keeps the click for the visit in session mode', () => {
    window.history.replaceState(null, '', `/?kma_click=${click}`)
    start({ autoPageViews: false, attribution: 'session' }).shutdown()
    expect(Object.keys(localStorage).some((k) => k.endsWith(':touch'))).toBe(false)
    vi.advanceTimersByTime(5 * 60_000)
    window.history.replaceState(null, '', '/checkout')
    const next = start({ autoPageViews: false, attribution: 'session' })
    expect(next.getClickId()).toBe(click)
    next.shutdown()
    // The visit ended: nothing is left.
    vi.advanceTimersByTime(31 * 60_000)
    expect(start({ autoPageViews: false, attribution: 'session' }).getClickId()).toBeNull()
  })

  it('answers from memory when storage is blocked, and never throws', () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
    try {
      window.history.replaceState(null, '', '/')
      const none = start({ autoPageViews: false })
      expect(none.getClickId()).toBeNull()
      none.shutdown()
      window.history.replaceState(null, '', `/?kma_click=${click}`)
      expect(start({ autoPageViews: false }).getClickId()).toBe(click)
    } finally {
      get.mockRestore()
      set.mockRestore()
      remove.mockRestore()
    }
  })

  it('ignores a stored click that was tampered with', () => {
    window.history.replaceState(null, '', `/?kma_click=${click}`)
    start({ autoPageViews: false }).shutdown()
    const touchKey = Object.keys(localStorage).find((k) => k.endsWith(':touch'))!
    const touches = JSON.parse(localStorage.getItem(touchKey)!)
    touches.first.click.kma_click = 'not a click id'
    touches.last.click = 'nonsense'
    localStorage.setItem(touchKey, JSON.stringify(touches))
    const stateKey = touchKey.replace(/:touch$/, '')
    localStorage.removeItem(stateKey)
    window.history.replaceState(null, '', '/')
    expect(start({ autoPageViews: false }).getClickId()).toBeNull()
  })
})

describe('revenue', () => {
  /** The reserved properties, as integrations/analytics-mobile/contract sets them. */
  function expectRevenueContract(properties: Record<string, unknown>) {
    const { revenue } = contract
    for (const field of revenue.properties.required) expect(properties).toHaveProperty(field)
    const amount = properties.kma_revenue as number
    expect(Number.isFinite(amount) && amount !== 0).toBe(true)
    expect(Math.abs(amount)).toBeLessThanOrEqual(revenue.max_amount)
    expect(properties.kma_currency).toMatch(new RegExp(revenue.kma_currency))
    for (const field of revenue.properties.optional.filter((name) => name in properties)) {
      expect(String(properties[field]).length).toBeGreaterThan(0)
      expect(String(properties[field]).length).toBeLessThanOrEqual(revenue.id_max_length)
    }
  }

  it('sends a payment and a refund with the reserved properties, which win over extras', async () => {
    const kma = start({ autoPageViews: false })
    kma.revenue(59.99, 'usd', {
      productId: 'annual',
      transactionId: 'pi_3Q8x',
      properties: { plan: 'annual', kma_revenue: 1, kma_currency: 'GBP', kma_product_id: 'x' },
    })
    kma.revenue(-59.99, 'USD', { transactionId: 'pi_3Q8x' })
    kma.revenue(4.5, 'EUR', { event: 'coins_bought', properties: { kma_transaction_id: 'x' } })
    await vi.advanceTimersByTimeAsync(2000)
    const [, purchase, refund, coins] = eventsSent()
    expect(purchase.name).toBe(contract.revenue.default_event.payment)
    expect(purchase.properties).toEqual({
      plan: 'annual',
      kma_revenue: 59.99,
      kma_currency: 'USD',
      kma_product_id: 'annual',
      kma_transaction_id: 'pi_3Q8x',
    })
    expect(refund.name).toBe(contract.revenue.default_event.refund)
    expect(refund.properties).toEqual({
      kma_revenue: -59.99,
      kma_currency: 'USD',
      kma_transaction_id: 'pi_3Q8x',
    })
    expect(coins).toMatchObject({
      name: 'coins_bought',
      properties: { kma_revenue: 4.5, kma_currency: 'EUR' },
    })
    expect(coins.properties).not.toHaveProperty('kma_transaction_id')
    for (const event of [purchase, refund, coins]) expectRevenueContract(event.properties)
  })

  it('sends nothing for an amount or currency that is not valid, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const kma = start({ autoPageViews: false, debug: true })
    for (const amount of [0, -0, NaN, Infinity, -Infinity, 1e9 + 1, -2e9, '9.99', null])
      kma.revenue(amount as number, 'USD')
    for (const currency of ['US', 'USDT', '', 'U$D', 'ÜSD', 12, null, undefined])
      kma.revenue(9.99, currency as string)
    expect(eventsSent()).toEqual([])
    kma.revenue(1e9, 'USD')
    kma.revenue(-1e9, ' gbp ', null as unknown as RevenueOptions)
    kma.revenue(2, 'USD', {
      productId: '  ',
      transactionId: 'x'.repeat(201),
      properties: [] as unknown as Properties,
    })
    kma.revenue(2, 'USD', { event: 'not valid!' })
    await vi.advanceTimersByTimeAsync(2000)
    const sentEvents = eventsSent()
    expect(sentEvents.map((e) => e.name)).toEqual([
      'session_started',
      'purchase',
      'refund',
      'purchase',
    ])
    expect(sentEvents[1].properties).toEqual({ kma_revenue: 1e9, kma_currency: 'USD' })
    expect(sentEvents[2].properties).toEqual({ kma_revenue: -1e9, kma_currency: 'GBP' })
    expect(sentEvents[3].properties).toEqual({ kma_revenue: 2, kma_currency: 'USD' })
    const warnings = warn.mock.calls.map(([message]) => String(message))
    expect(warnings.filter((message) => message.includes('revenue needs an amount'))).toHaveLength(
      9,
    )
    expect(warnings.filter((message) => message.includes('three-letter currency'))).toHaveLength(8)
    expect(warnings.some((message) => message.includes('productId must be'))).toBe(true)
    expect(warnings.some((message) => message.includes('transactionId must be'))).toBe(true)
    expect(warnings.some((message) => message.includes('not a valid event name'))).toBe(true)
    warn.mockRestore()
  })

  it('sends nothing after opting out', async () => {
    const kma = start({ autoPageViews: false })
    await vi.advanceTimersByTimeAsync(2000)
    sent.length = 0
    kma.optOut()
    kma.revenue(9.99, 'USD')
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toEqual([])
  })
})

describe('script tag build', () => {
  it('answers getClickId with null before init and with the click after', async () => {
    vi.resetModules()
    window.history.replaceState(null, '', '/?kma_click=kc_7Hq2mW9xLp4RtZ8vB3nD')
    ;(window as unknown as { kma: unknown }).kma = Object.assign(() => undefined, { q: [] })
    await import('./src/global')
    const api = (
      window as unknown as {
        kma: {
          instance: Kma | null
          getClickId(): string | null
          init(key: string, options: Partial<KmaOptions>): Kma
        }
      }
    ).kma
    expect(api.instance).toBeNull()
    expect(api.getClickId()).toBeNull()
    instances.push(
      api.init(key, {
        endpoint: 'https://events.example',
        replay: false,
        fetch: fetchMock as typeof fetch,
        debug: false,
        autoPageViews: false,
      }),
    )
    expect(api.getClickId()).toBe('kc_7Hq2mW9xLp4RtZ8vB3nD')
  })

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
        ['revenue', 4.99, 'eur', { productId: 'coins_100' }],
      ],
    })
    ;(window as unknown as { kma: unknown }).kma = stub
    await import('./src/global')
    const api = (
      window as unknown as {
        kma: { instance: Kma; track(name: string): void; revenue(a: number, c: string): void }
      }
    ).kma
    expect(api.instance.getAnonymousId()).toMatch(/^[0-9a-f-]{36}$/)
    instances.push(api.instance)
    api.track('late_event')
    api.revenue(-4.99, 'EUR')
    await vi.advanceTimersByTimeAsync(2000)
    expect(eventsSent().map((e) => e.name)).toEqual([
      'session_started',
      'early_event',
      'purchase',
      'late_event',
      'refund',
    ])
    expect(eventsSent()[2].properties).toEqual({
      kma_revenue: 4.99,
      kma_currency: 'EUR',
      kma_product_id: 'coins_100',
    })
  })
})

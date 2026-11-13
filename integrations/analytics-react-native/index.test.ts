import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeepLink } from './src/index'

// A stand-in for React Native: an AppState whose changes the test drives, Linking with an
// opening link and `url` events, and the optional native module.
const native = vi.hoisted(() => {
  const listeners: ((state: string) => void)[] = []
  const links: ((event: { url: string }) => void)[] = []
  return {
    listeners,
    links,
    AppState: {
      currentState: 'active',
      addEventListener: (_type: string, listener: (state: string) => void) => {
        listeners.push(listener)
        return { remove: () => undefined }
      },
    },
    Linking: {
      initial: null as string | null,
      getInitialURL: async () => native.Linking.initial,
      addEventListener: (_type: string, handler: (event: { url: string }) => void) => {
        links.push(handler)
        return { remove: () => undefined }
      },
    },
    Platform: { OS: 'android', Version: 34, constants: { Release: '14', Model: 'Pixel 7' } },
    Dimensions: { get: () => ({ width: 412, height: 915, scale: 2.6 }) },
    NativeModules: { I18nManager: { localeIdentifier: 'en_NG' } } as Record<string, unknown>,
  }
})
vi.mock('react-native', () => native)

const key = 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ'
const deviceKey = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
type Sent = {
  path: string
  body: {
    events: { name: string; screen?: string }[]
    context: Record<string, unknown>
    [field: string]: unknown
  }
}
const sent: Sent[] = []
let reply: (path: string) => unknown = () => ({})
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://events.kissmyapps.dev', '')
    sent.push({ path, body: JSON.parse(String(init.body)) })
    return { ok: true, status: 200, text: async () => JSON.stringify(reply(path)) }
  }),
)

const events = () => sent.filter((request) => request.path === '/v1/events')
const attribution = () => sent.filter((request) => request.path !== '/v1/events')

/** Storage that answers later, as AsyncStorage does. */
function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: async (name: string) => data.get(name) ?? null,
    setItem: async (name: string, value: string) => {
      data.set(name, value)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  sent.length = 0
  native.listeners.length = 0
  native.links.length = 0
  native.Linking.initial = null
  delete native.NativeModules.KissMyAppsAttribution
  reply = () => ({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('React Native wiring', () => {
  it('follows the app between foreground and background, and keeps calls made before init', async () => {
    vi.useFakeTimers()
    const { KissMyApps, trackNavigation } = await import('./src/index')
    KissMyApps.track('opened_from_push')
    const client = KissMyApps.init({
      key,
      appVersion: '1.2.0',
    })
    expect(KissMyApps.init({ key: 'kma_pk_live_ZYXWVUTSRQPNMLKJHGFEDCBA' })).toBe(client)
    const tracking = trackNavigation({ getCurrentRoute: () => ({ name: 'Home' }) })
    tracking.onReady()
    await client.ready
    native.listeners.forEach((listener) => listener('background'))
    await vi.advanceTimersByTimeAsync(500)

    const recorded = events().flatMap((request) => request.body.events)
    expect(recorded.map((event) => event.name)).toEqual([
      'session_started',
      'app_installed',
      'app_opened',
      'opened_from_push',
      'screen_viewed',
      'app_backgrounded',
    ])
    expect(recorded.at(-1)?.screen).toBe('Home')
    expect(events()[0].body.context).toMatchObject({
      platform: 'android',
      os_name: 'Android',
      os_version: '14',
      device_model: 'Pixel 7',
      device_type: 'mobile',
      language: 'en-NG',
      screen_width: 412,
      sdk: 'kma-react-native/1.1.0',
    })

    sent.length = 0
    native.listeners.forEach((listener) => listener('active'))
    await KissMyApps.flush()
    expect(
      events()
        .flatMap((request) => request.body.events)
        .map((event) => event.name),
    ).toEqual(['app_opened'])
  })

  it('matches the install with the native module and the opening link, then reports links', async () => {
    vi.useFakeTimers()
    const asked: unknown[] = []
    native.NativeModules.KissMyAppsAttribution = {
      getAttributionInfo: async (request: unknown) => {
        asked.push(request)
        return {
          deviceKey,
          referrer: 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok',
          referrerClickTs: 1761818300,
          installBeginTs: 1761818320,
        }
      },
    }
    native.Linking.initial = 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4'
    reply = (path) =>
      path === '/v1/attribution/install'
        ? {
            matched: true,
            method: 'link_open',
            deep_link: { value: 'lesson', params: { id: '4' }, deferred: true },
          }
        : path === '/v1/attribution/open'
          ? {
              matched: true,
              method: 'link_open',
              deep_link: { value: 'promo', params: {}, deferred: false },
            }
          : {}
    const { KissMyApps } = await import('./src/index')
    const links: DeepLink[] = []
    // Set before init: the deep link waits for it.
    const stop = KissMyApps.onDeepLink((link) => links.push(link))
    const client = KissMyApps.init({ key, storage: memoryStorage(), appVersion: '1.2.0' })
    await client.ready
    await vi.advanceTimersByTimeAsync(500)

    expect(attribution().map((request) => request.path)).toEqual(['/v1/attribution/install'])
    expect(asked).toEqual([{ install: true, clipboard: false }])
    expect(attribution()[0].body).toMatchObject({
      platform: 'android',
      sdk: 'kma-react-native/1.1.0',
      app_version: '1.2.0',
      device_key: deviceKey,
      link_url: 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4',
      referrer: 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok',
      referrer_click_ts: 1761818300,
      install_begin_ts: 1761818320,
    })
    expect(links).toEqual([
      {
        value: 'lesson',
        params: { id: '4' },
        deferred: true,
        url: 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4',
      },
    ])

    // A link while the app runs, and the same link from the app itself, count once.
    sent.length = 0
    native.links.forEach((handler) => handler({ url: 'https://fluent.go.kissmyapps.dev/promo' }))
    expect(KissMyApps.handleDeepLink('https://fluent.go.kissmyapps.dev/promo')).toBe(true)
    expect(KissMyApps.handleDeepLink('fluent://lesson/4')).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(attribution().map((request) => request.path)).toEqual(['/v1/attribution/open'])
    expect(attribution()[0].body).toMatchObject({
      url: 'https://fluent.go.kissmyapps.dev/promo',
      device_key: deviceKey,
    })
    expect(asked).toHaveLength(1)
    expect(links.at(-1)).toEqual({
      value: 'promo',
      params: {},
      deferred: false,
      url: 'https://fluent.go.kissmyapps.dev/promo',
    })
    stop()
  })

  it('leaves out the opening link of an activity Android reopened from Recents', async () => {
    vi.useFakeTimers()
    native.NativeModules.KissMyAppsAttribution = {
      getAttributionInfo: async () => ({ deviceKey }),
      launchedFromHistory: async () => true,
    }
    native.Linking.initial = 'https://fluent.go.kissmyapps.dev/old-link'
    const { KissMyApps } = await import('./src/index')
    const client = KissMyApps.init({ key, storage: memoryStorage() })
    await client.ready
    await vi.advanceTimersByTimeAsync(500)
    expect(attribution().map((request) => request.path)).toEqual(['/v1/attribution/install'])
    expect(attribution()[0].body).not.toHaveProperty('link_url')
    expect(attribution()[0].body.device_key).toBe(deviceKey)
  })

  it('still matches the install without the native module, as in Expo Go', async () => {
    vi.useFakeTimers()
    const { KissMyApps } = await import('./src/index')
    const client = KissMyApps.init({ key, storage: memoryStorage() })
    await client.ready
    await vi.advanceTimersByTimeAsync(500)
    const [install] = attribution()
    expect(install.path).toBe('/v1/attribution/install')
    expect(Object.keys(install.body).sort()).toEqual([
      'anonymous_id',
      'installed_at',
      'platform',
      'sdk',
      'session_id',
    ])
  })
})

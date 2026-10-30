import { afterEach, describe, expect, it, vi } from 'vitest'

// A stand-in for React Native: an AppState whose changes the test drives.
const native = vi.hoisted(() => {
  const listeners: ((state: string) => void)[] = []
  return {
    listeners,
    AppState: {
      currentState: 'active',
      addEventListener: (_type: string, listener: (state: string) => void) => {
        listeners.push(listener)
        return { remove: () => undefined }
      },
    },
    Platform: { OS: 'android', Version: 34, constants: { Release: '14', Model: 'Pixel 7' } },
    Dimensions: { get: () => ({ width: 412, height: 915, scale: 2.6 }) },
    NativeModules: { I18nManager: { localeIdentifier: 'en_NG' } },
  }
})
vi.mock('react-native', () => native)

const sent: { events: { name: string; screen?: string }[]; context: Record<string, unknown> }[] = []
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    return { ok: true, status: 200, text: async () => '{}' }
  }),
)

afterEach(() => {
  vi.useRealTimers()
})

describe('React Native wiring', () => {
  it('follows the app between foreground and background, and keeps calls made before init', async () => {
    vi.useFakeTimers()
    const { KissMyApps, trackNavigation } = await import('./src/index')
    KissMyApps.track('opened_from_push')
    const client = KissMyApps.init({
      key: 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ',
      appVersion: '1.2.0',
    })
    expect(KissMyApps.init({ key: 'kma_pk_live_ZYXWVUTSRQPNMLKJHGFEDCBA' })).toBe(client)
    const tracking = trackNavigation({ getCurrentRoute: () => ({ name: 'Home' }) })
    tracking.onReady()
    await client.ready
    native.listeners.forEach((listener) => listener('background'))
    await vi.advanceTimersByTimeAsync(500)

    const events = sent.flatMap((body) => body.events)
    expect(events.map((event) => event.name)).toEqual([
      'session_started',
      'app_installed',
      'app_opened',
      'opened_from_push',
      'screen_viewed',
      'app_backgrounded',
    ])
    expect(events.at(-1)?.screen).toBe('Home')
    expect(sent[0].context).toMatchObject({
      platform: 'android',
      os_name: 'Android',
      os_version: '14',
      device_model: 'Pixel 7',
      device_type: 'mobile',
      language: 'en-NG',
      screen_width: 412,
      sdk: 'kma-react-native/1.0.0',
    })

    sent.length = 0
    native.listeners.forEach((listener) => listener('active'))
    await KissMyApps.flush()
    expect(sent.flatMap((body) => body.events).map((event) => event.name)).toEqual(['app_opened'])
  })
})

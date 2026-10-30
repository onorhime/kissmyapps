// KissMyApps analytics for React Native: sessions, installs, opens, screens and your own
// events, sent to your KissMyApps project. Pure JavaScript, so there is nothing to link.

import { AppState } from 'react-native'
import { KmaClient, SDK_VERSION } from './client'
import type { ClientOptions, Properties, Storage } from './client'
import { deviceInfo } from './device'
import { navigationTracker } from './navigation'
import type { NavigationRefLike } from './navigation'

export { KmaClient, SDK_VERSION } from './client'
export type { ClientOptions, DeviceInfo, Properties, Storage } from './client'
export type { NavigationRefLike } from './navigation'

export interface InitOptions extends ClientOptions {
  /** Where the SDK keeps its IDs and offline queue, such as AsyncStorage. */
  storage?: Storage
}

let client: KmaClient | null = null
// Calls made before init run once it is called.
const early: ((client: KmaClient) => void)[] = []

function call(run: (client: KmaClient) => void): void {
  if (client) run(client)
  else if (early.length < 100) early.push(run)
}

export const KissMyApps = {
  /** Starts the SDK once, as early as possible, with the project's client key. */
  init(options: InitOptions): KmaClient {
    if (client) return client
    const started = new KmaClient(options, {
      storage: options.storage ?? null,
      device: deviceInfo,
      fetch: (url, init) => fetch(url, init),
      sdk: `kma-react-native/${SDK_VERSION}`,
    })
    client = started
    if (AppState.currentState !== 'background') started.foreground()
    AppState.addEventListener('change', (state) => {
      if (state === 'active') started.foreground()
      else if (state === 'background') started.background()
    })
    for (const run of early.splice(0)) run(started)
    return started
  },
  track(name: string, properties?: Properties): void {
    call((kma) => kma.track(name, properties))
  },
  screen(name: string, properties?: Properties): void {
    call((kma) => kma.screen(name, properties))
  },
  identify(userId: string | number, traits?: Properties): void {
    call((kma) => kma.identify(userId, traits))
  },
  setTraits(traits: Properties): void {
    call((kma) => kma.setTraits(traits))
  },
  reset(): void {
    call((kma) => kma.reset())
  },
  flush(): Promise<void> {
    return client?.flush() ?? Promise.resolve()
  },
  optOut(): void {
    call((kma) => kma.optOut())
  },
  optIn(): void {
    call((kma) => kma.optIn())
  },
  getAnonymousId(): string | null {
    return client?.getAnonymousId() ?? null
  },
  getSessionId(): string | null {
    return client?.getSessionId() ?? null
  },
}

/**
 * Screen views from React Navigation:
 * `<NavigationContainer ref={ref} {...trackNavigation(ref)}>`.
 */
export function trackNavigation(ref: NavigationRefLike) {
  return navigationTracker(ref, (name) => KissMyApps.screen(name))
}

export default KissMyApps

// KissMyApps analytics for React Native: sessions, installs, opens, screens and your own
// events, sent to your KissMyApps project, plus install attribution and deep links. Plain
// JavaScript; the optional native module KissMyAppsAttribution adds the device key, the
// Google Play install referrer and the Apple Ads token when it is linked.

import { AppState, Linking, NativeModules } from 'react-native'
import type { AttributionInfo, AttributionRequest, DeepLink } from './attribution'
import { httpsLink } from './attribution'
import { KmaClient, SDK_VERSION } from './client'
import type { ClientOptions, Properties, Storage } from './client'
import { deviceInfo } from './device'
import { navigationTracker } from './navigation'
import type { NavigationRefLike } from './navigation'

export { KmaClient, SDK_VERSION } from './client'
export type { ClientOptions, DeviceInfo, Properties, Storage } from './client'
export type { AttributionInfo, DeepLink } from './attribution'
export type { NavigationRefLike } from './navigation'

export interface InitOptions extends ClientOptions {
  /** Where the SDK keeps its IDs and offline queue, such as AsyncStorage. */
  storage?: Storage
  /**
   * Read the link that opened the app (Linking.getInitialURL) and links opened while it runs
   * (Linking's `url` events). Default true. Turn it off to call handleDeepLink yourself.
   */
  deepLinks?: boolean
}

interface NativeAttribution {
  getAttributionInfo(request: AttributionRequest): Promise<AttributionInfo | null>
  /** Android: the activity was reopened from Recents, so its link is an old one. */
  launchedFromHistory?(): Promise<boolean>
}

/** The link that opened the app, unless Android reopened the activity from Recents. */
async function openingLink(native: NativeAttribution | null): Promise<string | null> {
  const url = await Linking.getInitialURL()
  if (!url || !native?.launchedFromHistory) return url
  const old = await native.launchedFromHistory().catch(() => false)
  return old === true ? null : url
}

/** The optional native module, when the app has it linked (not in Expo Go). */
function nativeAttribution(): NativeAttribution | null {
  const module: unknown = NativeModules.KissMyAppsAttribution
  return module && typeof (module as NativeAttribution).getAttributionInfo === 'function'
    ? (module as NativeAttribution)
    : null
}

let client: KmaClient | null = null
let deepLinkHandler: ((link: DeepLink) => void) | null = null
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
    const native = nativeAttribution()
    // Linking is there in every React Native app; a test's stand-in may leave it out.
    const links =
      options.deepLinks !== false &&
      options.attribution !== false &&
      Boolean(Linking?.getInitialURL)
    const started = new KmaClient(options, {
      storage: options.storage ?? null,
      device: deviceInfo,
      fetch: (url, init) => fetch(url, init),
      sdk: `kma-react-native/${SDK_VERSION}`,
      initialLink: links ? () => openingLink(native) : undefined,
      attributionInfo: native ? (request) => native.getAttributionInfo(request) : undefined,
    })
    client = started
    if (deepLinkHandler) started.onDeepLink(deepLinkHandler)
    if (AppState.currentState !== 'background') started.foreground()
    AppState.addEventListener('change', (state) => {
      if (state === 'active') started.foreground()
      else if (state === 'background') started.background()
    })
    if (links) Linking.addEventListener?.('url', ({ url }) => started.handleDeepLink(url))
    for (const run of early.splice(0)) run(started)
    return started
  },
  /**
   * Reports a link that opened the app. With `deepLinks` on (the default) the SDK already
   * reads Linking, so call this only for links that reach the app another way. Returns false
   * when the link is not sent (not an https link, attribution off, opted out).
   */
  handleDeepLink(url: string): boolean {
    if (client) return client.handleDeepLink(url)
    if (!httpsLink(url)) return false
    call((kma) => kma.handleDeepLink(url))
    return true
  },
  /**
   * Where deep links go: the deferred one after an install, and one each time a link opens
   * the app. Each is handed over once; one that arrives before a handler is set waits for it.
   * Returns a function that removes the handler.
   */
  onDeepLink(handler: (link: DeepLink) => void): () => void {
    deepLinkHandler = handler
    client?.onDeepLink(handler)
    return () => {
      if (deepLinkHandler !== handler) return
      deepLinkHandler = null
      client?.onDeepLink(null)
    }
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

// The KissMyApps app client, with no React Native in it: the app's storage, device and
// network come in through `Environment`, so the same code runs in tests and in Node.
// The Android and iOS SDKs follow the same rules; see integrations/analytics-mobile.

import {
  INSTALL_PATH,
  OPEN_PATH,
  deepLinkFrom,
  deviceKey,
  httpsLink,
  installBody,
  openBody,
  parseAnswer,
  within,
} from './attribution'
import type { AttributionInfo, AttributionRequest, DeepLink } from './attribution'

export const SDK_VERSION = '1.1.0'
export const DEFAULT_ENDPOINT = 'https://events.kissmyapps.dev'

export type Properties = Record<string, unknown>

/** AsyncStorage, MMKV or anything with the same two methods. */
export interface Storage {
  getItem(key: string): Promise<string | null> | string | null
  setItem(key: string, value: string): Promise<void> | void
}

export interface DeviceInfo {
  platform: 'ios' | 'android'
  os_name: string
  os_version: string
  device_type: 'mobile' | 'tablet'
  device_model?: string
  screen_width: number
  screen_height: number
  timezone: string
  language: string
}

export interface ClientOptions {
  /** The project's client key, kma_pk_live_… or kma_pk_test_…. */
  key: string
  endpoint?: string
  /** The app's version, such as 2.4.0, and build number, such as 120. */
  appVersion?: string
  build?: string
  /** A session ends after this long in the background or without events. Default 30. */
  sessionTimeoutMinutes?: number
  /** How often queued events are sent while the app is open. Default 10. */
  flushIntervalSeconds?: number
  /** The most events kept while offline; the oldest go first. Default 1000. */
  maxQueue?: number
  /** Record installs, updates, opens and backgrounding. Default true. */
  trackLifecycle?: boolean
  /**
   * Match the install to the link that brought it on the first launch, and report links that
   * open the app. Default true. Nothing is matched until attribution is on for the project.
   */
  attribution?: boolean
  /**
   * iPhone only: on the first launch, read a `kma:` click ID that the smart link's page put on
   * the clipboard. Turn it on only with "Clipboard handoff for iPhone" on in the console:
   * iOS asks the person before an app reads what another app copied. Default false.
   */
  clipboardHandoff?: boolean
  debug?: boolean
}

export interface RevenueOptions {
  /** Your product or plan, such as annual_plan. */
  productId?: string
  /**
   * The payment's ID at the store, such as StoreKit's transaction ID or Google Play's order
   * ID. The same payment reported by the app and by a RevenueCat or Adapty webhook with the
   * same ID counts once.
   */
  transactionId?: string
  /** The event's name. Default purchase, or refund for a negative amount. */
  event?: string
  /** More properties for the event. The kma_ revenue properties always win. */
  properties?: Properties
}

export interface Environment {
  storage: Storage | null
  device(): DeviceInfo
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>
  sdk: string
  now?: () => number
  log?: (message: string) => void
  /** The link that opened the app, such as Linking.getInitialURL(). */
  initialLink?: () => Promise<string | null>
  /** What the optional native module reads: device key, install referrer, Apple Ads token, if any. */
  attributionInfo?: (request: AttributionRequest) => Promise<AttributionInfo | null>
}

/** The first launch's install call, kept until it gets an answer and resent as it was. */
interface PendingInstall {
  /** When app_installed was queued. */
  at: number
  anonymousId: string
  sessionId: string
  /** The first link that opened the app on the first launch, before the call went out. */
  link?: string
  /** Calls made so far, one per launch. */
  tries: number
  /** What the device gave on the first try, without the Apple Ads token, which expires. */
  info?: AttributionInfo
  /** False when reading the install referrer timed out: the next try reads it again. */
  infoComplete?: boolean
}

/** This launch's install call: links wait for its answer before they go to the open call. */
type InstallPhase = 'none' | 'waiting' | 'answered' | 'failed'

interface Session {
  id: string
  started: number
  last: number
  firstScreen?: string
}

interface State {
  anonymousId: string
  userId: string | null
  traits: Properties | null
  session: Session | null
  optedOut: boolean
  version?: string
  build?: string
  install?: PendingInstall | null
}

export interface QueuedEvent {
  name: string
  insert_id: string
  time: string
  screen?: string
  properties: Properties
  user_id: string | null
  anonymous_id: string
  session_id: string
  session_started_at: string
}

export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/
const KEY = /^kma_pk_(live|test)_[A-Za-z0-9]{20,64}$/
const BATCH_SIZE = 50
const FLUSH_AT = 30
const HEARTBEAT_MS = 60_000
const MAX_PROPERTIES_BYTES = 32_000
// The first launch's call, then at most three more launches.
const INSTALL_TRIES = 4
// A link handed over twice this close together, by Linking and by the app, counts once.
const SAME_LINK_MS = 3000
// As the iOS SDK: the opening link has 1.5 seconds to arrive before the install call goes.
const INITIAL_LINK_WAIT_MS = 1500
// The native module waits up to 10 seconds for Google Play's install referrer.
const NATIVE_WAIT_MS = 12_000
const FLUSH_WAIT_MS = 5000
// The properties a payment event carries; reports read revenue from them.
const REVENUE_KEYS = ['kma_revenue', 'kma_currency', 'kma_product_id', 'kma_transaction_id']
const MAX_REVENUE = 1e9
const CURRENCY = /^[A-Za-z]{3}$/

/** A product or transaction ID as reports keep it: text of 1 to 200 characters. */
function revenueId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim() : ''
  return id && id.length <= 200 ? id : undefined
}

export function uuid(): string {
  // Hermes has no crypto.randomUUID; a polyfill may add it.
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (random?.randomUUID) return random.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export class KmaClient {
  readonly options: ClientOptions & { endpoint: string }
  private readonly env: Environment
  private readonly storageKey: string
  private state: State
  private queue: QueuedEvent[] = []
  private screenName: string | null = null
  private foregroundAt = 0
  private loaded = false
  private readonly waiting: (() => void)[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private failures = 0
  private lastSent = 0
  private identityPending = false
  private inForeground = false
  private firstLaunch = false
  private stopped = false
  private launched = false
  // This launch is the first launch: its first link goes with the install call.
  private firstLaunchNow = false
  private installRunning = false
  // This launch's try is on its way (one try per launch).
  private installSent = false
  private installPhase: InstallPhase = 'none'
  private linksBeforeLaunch: { url: string; at: number }[] = []
  private waitingLinks: { url: string; at: number }[] = []
  private readonly recentLinks = new Map<string, number>()
  private deviceKeyRead: string | null | undefined
  private deepLinkHandler: ((link: DeepLink) => void) | null = null
  private heldDeepLink: DeepLink | null = null
  private readonly initialLink: Promise<string | null>
  /** Settles once saved state is read and the launch is recorded. */
  readonly ready: Promise<void>

  constructor(options: ClientOptions, env: Environment) {
    if (!KEY.test(options.key ?? '')) {
      throw new Error('KissMyApps: init needs a client key that starts with kma_pk_')
    }
    this.options = {
      ...options,
      endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    }
    this.env = env
    this.storageKey = `kma:${options.key.slice(-8)}`
    this.state = {
      anonymousId: uuid(),
      userId: null,
      traits: null,
      session: null,
      optedOut: false,
    }
    this.ready = this.load()
    const opening =
      env.initialLink && options.attribution !== false
        ? within(
            Promise.resolve().then(() => env.initialLink?.() ?? null),
            INITIAL_LINK_WAIT_MS,
            null,
          )
        : Promise.resolve(null)
    // Routed before the install call reads it, so the opening link goes with the install.
    this.initialLink = opening.then((url) => {
      if (url) this.handleDeepLink(url)
      return url
    })
  }

  // Public API ---------------------------------------------------------------------------

  /** Records something a person did. */
  track(name: string, properties: Properties = {}): void {
    this.whenLoaded(() => {
      if (this.stopped || this.state.optedOut) return
      if (!EVENT_NAME.test(name)) {
        this.warn(
          `"${name}" is not a valid event name: use letters, numbers and _ . : - (up to 80).`,
        )
        return
      }
      this.enqueue(name, properties, this.ensureSession())
    })
  }

  /**
   * Records a payment: the amount in major units (9.99, not 999), negative for a refund, and
   * its ISO 4217 currency code. Sent as a purchase (or refund) event with kma_revenue and
   * kma_currency. An amount or currency that is not valid sends nothing (a warning in debug).
   */
  revenue(amount: number, currency: string, options: RevenueOptions = {}): void {
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_REVENUE
    ) {
      return this.warn(
        'revenue needs an amount that is not 0 and at most 1,000,000,000 either way (negative for a refund).',
      )
    }
    const code = typeof currency === 'string' ? currency.trim() : ''
    if (!CURRENCY.test(code)) {
      return this.warn(
        `revenue needs a three-letter currency code such as USD, not "${String(currency)}".`,
      )
    }
    const { productId, transactionId, event, properties } = options ?? {}
    const values: Properties =
      properties && typeof properties === 'object' && !Array.isArray(properties)
        ? { ...properties }
        : {}
    for (const field of REVENUE_KEYS) delete values[field]
    values.kma_revenue = amount
    values.kma_currency = code.toUpperCase()
    const product = revenueId(productId)
    const transaction = revenueId(transactionId)
    if (product) values.kma_product_id = product
    else if (productId != null) this.warn('productId must be 1 to 200 characters; it was left out.')
    if (transaction) values.kma_transaction_id = transaction
    else if (transactionId != null)
      this.warn('transactionId must be 1 to 200 characters; it was left out.')
    this.track(event || (amount > 0 ? 'purchase' : 'refund'), values)
  }

  /** Records a screen view; later events carry the screen's name. */
  screen(name: string, properties: Properties = {}): void {
    const screen = String(name ?? '')
      .trim()
      .slice(0, 300)
    if (!screen) return this.warn('screen needs a name.')
    this.whenLoaded(() => {
      if (this.stopped || this.state.optedOut) return
      const previous = this.screenName
      this.screenName = screen
      const session = this.ensureSession()
      if (!session.firstScreen) {
        session.firstScreen = screen
        this.save()
      }
      this.enqueue(
        'screen_viewed',
        { name: screen, ...(previous ? { previous } : {}), ...properties },
        session,
      )
    })
  }

  /** Ties this install to your own user ID, with optional traits such as email, name or plan. */
  identify(userId: string | number, traits?: Properties): void {
    const id = String(userId ?? '').trim()
    if (!id || id.length > 200) return this.warn('identify needs a user ID of 1 to 200 characters.')
    this.whenLoaded(() => {
      this.state.userId = id
      if (traits) this.state.traits = { ...(this.state.traits ?? {}), ...this.clean(traits) }
      this.identityPending = true
      this.save()
      this.scheduleFlush(0)
    })
  }

  /** Updates traits for the current person without changing who they are. */
  setTraits(traits: Properties): void {
    this.whenLoaded(() => {
      this.state.traits = { ...(this.state.traits ?? {}), ...this.clean(traits) }
      this.identityPending = true
      this.save()
      this.scheduleFlush(0)
    })
  }

  /** Forgets the user, for example on sign out: what follows is a new person and session. */
  reset(): void {
    this.whenLoaded(() => {
      void this.flush()
      this.state.userId = null
      this.state.traits = null
      this.identityPending = false
      this.state.anonymousId = uuid()
      this.state.session = null
      this.save()
      if (this.inForeground) this.ensureSession()
    })
  }

  /** Stops recording and drops anything not sent yet, until optIn. Remembered across launches. */
  optOut(): void {
    this.whenLoaded(() => {
      this.state.optedOut = true
      this.queue = []
      this.save()
    })
  }

  optIn(): void {
    this.whenLoaded(() => {
      this.state.optedOut = false
      this.save()
      // An install call held back while opted out goes now.
      if (
        this.launched &&
        this.state.install &&
        this.options.attribution !== false &&
        !this.installSent &&
        !this.installRunning
      ) {
        this.installPhase = 'waiting'
        void this.sendInstall()
      }
    })
  }

  /**
   * Reports a link that opened the app, such as a Universal Link or App Link. Any https link
   * is sent and KissMyApps decides whether it is one of the project's links; its deep link then
   * goes to `onDeepLink`. Returns false when nothing is sent (not https, longer than 2,048
   * characters, attribution off, opted out). The same link handed over twice within 3 seconds
   * counts once, so Linking and the app may both report it.
   */
  handleDeepLink(url: string): boolean {
    if (this.options.attribution === false || this.stopped) return false
    const link = httpsLink(url)
    if (!link) return false
    if (this.loaded && this.state.optedOut) return false
    const at = this.now()
    this.whenLoaded(() => this.routeLink(link, at))
    return true
  }

  /**
   * Where deep links go: the deferred one after an install, and one each time a link opens the
   * app. Each deep link is handed over once; one that arrives before a handler is set is held
   * and handed to the next handler set. Pass null to stop.
   */
  onDeepLink(handler: ((link: DeepLink) => void) | null): void {
    this.deepLinkHandler = handler
    const held = this.heldDeepLink
    if (handler && held) {
      this.heldDeepLink = null
      this.deliver(held)
    }
  }

  getAnonymousId(): string {
    return this.state.anonymousId
  }

  getUserId(): string | null {
    return this.state.userId
  }

  getSessionId(): string | null {
    return this.state.session?.id ?? null
  }

  /** Sends everything queued now. */
  flush(): Promise<void> {
    if (!this.loaded) return this.ready.then(() => this.flush())
    if (this.inflight) return this.inflight
    this.inflight = this.sendQueued().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Stops timers; the client records nothing more. */
  shutdown(): void {
    this.stopped = true
    this.inForeground = false
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      void this.writeNow()
    }
  }

  // App lifecycle, called by the platform layer ------------------------------------------

  /** The app came to the front. The first call is the launch. */
  foreground(): void {
    this.whenLoaded(() => {
      if (this.stopped || this.inForeground) return
      const launch = this.foregroundAt === 0
      this.launched = true
      this.inForeground = true
      this.foregroundAt = this.now()
      if (this.state.optedOut) return
      const session = this.ensureSession()
      const firstLaunch = launch && this.firstLaunch
      if (this.options.trackLifecycle !== false) {
        if (launch) this.recordInstallOrUpdate(session)
        this.enqueue('app_opened', { from_background: !launch }, session)
      }
      if (launch) this.attributeLaunch(session, firstLaunch)
      this.heartbeatTimer ??= setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    })
  }

  /** The app went to the background: record it and send what is queued while it can. */
  background(): void {
    this.whenLoaded(() => {
      if (this.stopped || !this.inForeground) return
      this.inForeground = false
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      if (this.state.optedOut) return
      const session = this.state.session
      if (session && this.options.trackLifecycle !== false) {
        const seconds = Math.round((this.now() - this.foregroundAt) / 1000)
        this.enqueue('app_backgrounded', { seconds_in_foreground: Math.max(0, seconds) }, session)
      }
      if (session) session.last = this.now()
      void this.writeNow()
      void this.flush()
    })
  }

  // State --------------------------------------------------------------------------------

  private async load(): Promise<void> {
    const storage = this.env.storage
    if (!storage) this.warn('No storage was given, so each launch counts as a new install.')
    let saved: Partial<State> | null = null
    let queue: QueuedEvent[] = []
    try {
      const raw = await storage?.getItem(this.storageKey)
      saved = raw ? (JSON.parse(raw) as Partial<State>) : null
      const rawQueue = await storage?.getItem(`${this.storageKey}:queue`)
      queue = rawQueue ? (JSON.parse(rawQueue) as QueuedEvent[]) : []
    } catch {
      saved = null
    }
    if (saved?.anonymousId) {
      this.state = {
        anonymousId: saved.anonymousId,
        userId: saved.userId ?? null,
        traits: saved.traits ?? null,
        session: saved.session ?? null,
        optedOut: saved.optedOut === true,
        version: saved.version,
        build: saved.build,
        install: pendingInstall(saved.install),
      }
    }
    // Nothing saved means a first launch, or the app's data was cleared.
    this.firstLaunch = !saved?.anonymousId
    this.queue = Array.isArray(queue) ? queue : []
    this.identityPending = Boolean(this.state.traits)
    this.loaded = true
    // What an earlier launch could not send goes now.
    if (this.queue.length) this.scheduleFlush(0)
    for (const run of this.waiting.splice(0)) run()
  }

  private whenLoaded(run: () => void): void {
    if (this.loaded) run()
    else this.waiting.push(run)
  }

  private recordInstallOrUpdate(session: Session): void {
    const version = this.options.appVersion
    const build = this.options.build
    if (this.firstLaunch) {
      this.enqueue('app_installed', this.clean({ version, build }), session)
    } else if (
      (version && this.state.version && version !== this.state.version) ||
      (build && this.state.build && build !== this.state.build)
    ) {
      this.enqueue(
        'app_updated',
        this.clean({
          version,
          build,
          previous_version: this.state.version,
          previous_build: this.state.build,
        }),
        session,
      )
    }
    this.firstLaunch = false
    this.state.version = version ?? this.state.version
    this.state.build = build ?? this.state.build
    this.save()
  }

  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.writeNow()
    }, 250)
  }

  private async writeNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      await this.env.storage?.setItem(this.storageKey, JSON.stringify(this.state))
      await this.env.storage?.setItem(`${this.storageKey}:queue`, JSON.stringify(this.queue))
    } catch {
      // Storage full or failing: the client keeps working in memory.
    }
  }

  // Sessions and events -------------------------------------------------------------------

  private now(): number {
    return this.env.now?.() ?? Date.now()
  }

  private ensureSession(): Session {
    const now = this.now()
    const timeout = (this.options.sessionTimeoutMinutes ?? 30) * 60_000
    let session = this.state.session
    if (!session || now - session.last > timeout) {
      session = { id: uuid(), started: now, last: now, firstScreen: this.screenName ?? undefined }
      this.state.session = session
      this.enqueue('session_started', {}, session)
    } else {
      session.last = now
    }
    return session
  }

  private enqueue(name: string, properties: Properties, session: Session): void {
    this.queue.push({
      name,
      insert_id: uuid(),
      time: new Date(this.now()).toISOString(),
      screen: this.screenName ?? undefined,
      properties: this.clean(properties),
      user_id: this.state.userId,
      anonymous_id: this.state.anonymousId,
      session_id: session.id,
      session_started_at: new Date(session.started).toISOString(),
    })
    const max = this.options.maxQueue ?? 1000
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max)
    this.save()
    this.scheduleFlush(
      this.queue.length >= FLUSH_AT ? 0 : (this.options.flushIntervalSeconds ?? 10) * 1000,
    )
  }

  private clean(properties: Properties): Properties {
    try {
      const json = JSON.stringify(properties ?? {})
      if (json.length > MAX_PROPERTIES_BYTES) {
        this.warn('Event properties are over 32 KB and were dropped.')
        return {}
      }
      const parsed = JSON.parse(json)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  // Sending ------------------------------------------------------------------------------

  private context(session: Session | null): Properties {
    const device = this.env.device()
    return {
      platform: device.platform,
      sdk: this.env.sdk,
      timezone: device.timezone,
      language: device.language,
      device_type: device.device_type,
      device_model: device.device_model,
      os_name: device.os_name,
      os_version: device.os_version,
      app_version: this.options.appVersion,
      screen_width: Math.round(device.screen_width),
      screen_height: Math.round(device.screen_height),
      page_path: session?.firstScreen,
    }
  }

  /** One request's body: queued events share a person and session; with none, a heartbeat. */
  body(events: QueuedEvent[]): Properties {
    const head = events[0]
    const session = this.state.session
    const sessionId = head?.session_id ?? session?.id
    const startedAt =
      head?.session_started_at ?? (session ? new Date(session.started).toISOString() : undefined)
    const live = session?.id === sessionId ? session : null
    const current = !head || head.anonymous_id === this.state.anonymousId
    const userId = current ? this.state.userId : events[events.length - 1].user_id
    const body: Properties = {
      anonymous_id: head?.anonymous_id ?? this.state.anonymousId,
      session: sessionId ? { id: sessionId, started_at: startedAt } : undefined,
      sent_at: new Date(this.now()).toISOString(),
      context: this.context(live),
      events: events.map(({ name, insert_id, time, screen, properties, user_id }) => ({
        name,
        insert_id,
        time,
        ...(screen ? { screen } : {}),
        properties,
        user_id,
      })),
    }
    if (userId) body.user_id = userId
    if (current && this.state.traits) body.traits = this.state.traits
    return JSON.parse(JSON.stringify(body))
  }

  private nextBatch(): QueuedEvent[] {
    const head = this.queue[0]
    if (!head) return []
    const batch: QueuedEvent[] = []
    for (const event of this.queue) {
      if (
        event.session_id !== head.session_id ||
        event.anonymous_id !== head.anonymous_id ||
        batch.length >= BATCH_SIZE
      )
        break
      batch.push(event)
    }
    return batch
  }

  private async post(body: Properties, path = '/v1/events') {
    return this.env.fetch(`${this.options.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.key}` },
      body: JSON.stringify(body),
    })
  }

  private async sendQueued(): Promise<void> {
    while (!this.stopped && !this.state.optedOut) {
      const batch = this.nextBatch()
      if (!batch.length && !(this.identityPending && this.state.session)) return
      const traitsSent = this.state.traits
      const carriesIdentity = !batch.length || batch[0].anonymous_id === this.state.anonymousId
      let response: Awaited<ReturnType<Environment['fetch']>>
      try {
        response = await this.post(this.body(batch))
      } catch {
        this.retryLater()
        return
      }
      const refused =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      if (!response.ok && !refused) {
        this.retryLater()
        return
      }
      if (refused)
        this.warn(
          `Events were refused (${response.status}): ${await response.text().catch(() => '')}`,
        )
      const sent = new Set(batch.map((event) => event.insert_id))
      this.queue = this.queue.filter((event) => !sent.has(event.insert_id))
      if (response.ok && carriesIdentity && this.state.traits === traitsSent) {
        this.state.traits = null
        this.identityPending = false
      }
      this.failures = 0
      this.lastSent = this.now()
      this.save()
    }
  }

  private retryLater(): void {
    this.failures += 1
    this.scheduleFlush(Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6)), true)
  }

  private scheduleFlush(delay: number, replace = false): void {
    if (this.stopped) return
    if (this.flushTimer) {
      if (delay > 0 && !replace) return
      clearTimeout(this.flushTimer)
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay)
  }

  /** Keeps an open app counted as online. */
  private heartbeat(): void {
    const session = this.state.session
    if (this.stopped || this.state.optedOut || !this.inForeground || !session) return
    session.last = this.now()
    if (this.queue.length || this.identityPending) {
      void this.flush()
      return
    }
    if (this.now() - this.lastSent < HEARTBEAT_MS - 1000) return
    this.post(this.body([]))
      .then(() => {
        this.lastSent = this.now()
      })
      .catch(() => undefined)
  }

  // Attribution ---------------------------------------------------------------------------

  /** The launch: the first one queues the install call; links that came before it are routed. */
  private attributeLaunch(session: Session, firstLaunch: boolean): void {
    this.firstLaunch = false
    const early = this.linksBeforeLaunch.splice(0)
    if (this.options.attribution === false) return
    // Without storage every launch looks like the first, so there is no install to match.
    if (firstLaunch && this.env.storage) {
      this.state.install = {
        at: this.now(),
        anonymousId: this.state.anonymousId,
        sessionId: session.id,
        tries: 0,
      }
      this.firstLaunchNow = true
      this.save()
    }
    if (this.state.install) {
      this.installPhase = 'waiting'
      for (const link of early) this.routeLaunched(link.url, link.at)
      void this.sendInstall()
    } else {
      for (const link of early) void this.sendOpen(link.url, link.at)
    }
  }

  private routeLink(url: string, at: number): void {
    if (this.stopped || this.state.optedOut) return
    for (const [seen, when] of this.recentLinks) {
      if (at - when >= SAME_LINK_MS) this.recentLinks.delete(seen)
    }
    if (this.recentLinks.has(url)) return
    this.recentLinks.set(url, at)
    if (!this.launched) {
      if (this.linksBeforeLaunch.length < 10) this.linksBeforeLaunch.push({ url, at })
      return
    }
    this.routeLaunched(url, at)
  }

  private routeLaunched(url: string, at: number): void {
    const pending = this.state.install
    if (pending && this.installPhase === 'waiting') {
      // Only the first link of the first launch goes with the install call.
      if (this.firstLaunchNow && !this.installSent && !pending.tries && !pending.link) {
        pending.link = url
        this.save()
      } else if (this.waitingLinks.length < 10) {
        // Sent once the install is matched; an open first would record an install of its own.
        this.waitingLinks.push({ url, at })
      }
      return
    }
    if (pending && this.installPhase === 'failed') {
      this.warn('The link was not sent: the install is matched first, on the next launch.')
      return
    }
    void this.sendOpen(url, at)
  }

  /** The device's details; `complete` is false when the install referrer could not be read in time. */
  private async readNative(
    install: boolean,
    clipboard: boolean,
  ): Promise<{ info: AttributionInfo; complete: boolean }> {
    const read = this.env.attributionInfo
    if (!read) return { info: {}, complete: true }
    const request = {
      install,
      clipboard: install && clipboard && this.options.clipboardHandoff === true,
    }
    const info = await within<AttributionInfo | null>(
      Promise.resolve()
        .then(() => read(request))
        .then(
          (answer) => (answer && typeof answer === 'object' ? answer : {}),
          () => ({}),
        ),
      NATIVE_WAIT_MS,
      null,
    )
    if (!info) return { info: {}, complete: false }
    const key = deviceKey(info.deviceKey)
    if (key) this.deviceKeyRead = key
    return { info, complete: info.retryReferrer !== true }
  }

  /** The first try's details again; the Apple Ads token, and a referrer that timed out, are read anew. */
  private async installInfo(
    pending: PendingInstall,
  ): Promise<{ info: AttributionInfo; complete: boolean }> {
    const saved = pending.info
    if (saved && pending.infoComplete && this.env.device().platform === 'android') {
      return { info: saved, complete: true }
    }
    // The clipboard is read on the first try only.
    const read = await this.readNative(true, !saved)
    if (!saved) return read
    return {
      info: { ...read.info, ...definedOnly(saved), appleAdsToken: read.info.appleAdsToken },
      complete: pending.infoComplete === true || read.complete,
    }
  }

  /** The install call: once, on the first launch; again on the next launches if it failed. */
  private async sendInstall(): Promise<void> {
    if (this.installRunning) return
    this.installRunning = true
    try {
      await this.initialLink
      const first = this.state.install
      if (!first) return this.installAnswered()
      const { info, complete } = await this.installInfo(first)
      // app_installed and its session reach the server first.
      await within(this.flush(), FLUSH_WAIT_MS, undefined)
      const pending = this.state.install
      if (!pending) return this.installAnswered()
      if (this.stopped || this.state.optedOut || this.installSent) return
      this.installSent = true
      pending.tries += 1
      if (!pending.info || !pending.infoComplete) {
        pending.info = savedInfo(info)
        pending.infoComplete = complete
      }
      const device = this.env.device()
      const body = installBody({
        anonymousId: pending.anonymousId,
        sessionId: pending.sessionId,
        platform: device.platform,
        installedAt: pending.at,
        sdk: this.env.sdk,
        // Not after a reset: the install belongs to the person who installed.
        userId: pending.anonymousId === this.state.anonymousId ? this.state.userId : null,
        appVersion: this.options.appVersion,
        link: pending.link,
        info,
        clipboard: this.options.clipboardHandoff === true,
      })
      await this.writeNow()
      let response: Awaited<ReturnType<Environment['fetch']>>
      try {
        response = await this.post(body, INSTALL_PATH)
      } catch {
        return this.installFailed(pending, 'no connection')
      }
      if (!response.ok && retryable(response.status)) {
        return this.installFailed(pending, `status ${response.status}`)
      }
      // Answered: a refused body would be refused again, and an unreadable answer is still one.
      this.state.install = null
      void this.writeNow()
      const answer = await response.text().catch(() => '')
      if (response.ok) {
        this.deliver(deepLinkFrom(parseAnswer(answer), httpsLink(pending.link)))
      } else {
        this.warn(`The install was refused (${response.status}): ${answer}`)
      }
      this.installAnswered()
    } finally {
      this.installRunning = false
    }
  }

  /** Links that waited for the install's answer go to the open call now. */
  private installAnswered(): void {
    this.installPhase = 'answered'
    for (const link of this.waitingLinks.splice(0)) void this.sendOpen(link.url, link.at)
  }

  private installFailed(pending: PendingInstall, reason: string): void {
    if (pending.tries >= INSTALL_TRIES) {
      this.state.install = null
      this.warn(`The install could not be matched (${reason}); giving up.`)
      this.installAnswered()
    } else {
      this.warn(`The install could not be matched yet (${reason}); trying again next launch.`)
      this.installPhase = 'failed'
      if (this.waitingLinks.splice(0).length) {
        this.warn('Links that opened the app were not sent: the install is matched first.')
      }
    }
    void this.writeNow()
  }

  /** The open call, for a link that opened the app after the install was matched. Not retried. */
  private async sendOpen(url: string, at: number): Promise<void> {
    if (this.stopped || this.state.optedOut) return
    const session = this.ensureSession()
    const anonymousId = this.state.anonymousId
    const userId = this.state.userId
    const key =
      this.deviceKeyRead ?? deviceKey((await this.readNative(false, false)).info.deviceKey)
    if (this.stopped || this.state.optedOut) return
    const body = openBody({
      anonymousId,
      sessionId: session.id,
      platform: this.env.device().platform,
      url,
      openedAt: at,
      sdk: this.env.sdk,
      userId,
      appVersion: this.options.appVersion,
      deviceKey: key,
    })
    try {
      const response = await this.post(body, OPEN_PATH)
      const answer = await response.text().catch(() => '')
      if (!response.ok) {
        this.warn(`The link was refused (${response.status}): ${answer}`)
        return
      }
      this.deliver(deepLinkFrom(parseAnswer(answer), url))
    } catch {
      this.warn('The link could not be sent: no connection.')
    }
  }

  /** Hands a deep link to the handler; without one, the newest is held for the next handler. */
  private deliver(link: DeepLink | null): void {
    if (!link || this.stopped) return
    const handler = this.deepLinkHandler
    if (!handler) {
      this.heldDeepLink = link
      return
    }
    // Later, so a handler set during a render or an effect runs after it.
    setTimeout(() => {
      try {
        handler(link)
      } catch (error) {
        this.warn(`onDeepLink threw: ${String(error)}`)
      }
    }, 0)
  }

  private warn(message: string): void {
    if (this.options.debug) (this.env.log ?? console.warn)(`KissMyApps: ${message}`)
  }
}

function retryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429 || status < 400
}

function pendingInstall(value: unknown): PendingInstall | null {
  if (!value || typeof value !== 'object') return null
  const saved = value as Partial<PendingInstall>
  if (
    typeof saved.at !== 'number' ||
    typeof saved.anonymousId !== 'string' ||
    typeof saved.sessionId !== 'string'
  )
    return null
  const info = saved.info && typeof saved.info === 'object' ? savedInfo(saved.info) : undefined
  return {
    at: saved.at,
    anonymousId: saved.anonymousId,
    sessionId: saved.sessionId,
    link: typeof saved.link === 'string' ? saved.link : undefined,
    tries: typeof saved.tries === 'number' ? saved.tries : 0,
    info,
    infoComplete: info ? saved.infoComplete === true : undefined,
  }
}

/** What is kept for the next tries: everything but the Apple Ads token, which expires. */
function savedInfo(info: AttributionInfo): AttributionInfo {
  const kept: AttributionInfo = {}
  if (typeof info.deviceKey === 'string') kept.deviceKey = info.deviceKey
  if (typeof info.referrer === 'string') kept.referrer = info.referrer
  if (typeof info.referrerClickTs === 'number') kept.referrerClickTs = info.referrerClickTs
  if (typeof info.installBeginTs === 'number') kept.installBeginTs = info.installBeginTs
  if (typeof info.clipboardClick === 'string') kept.clipboardClick = info.clipboardClick
  return kept
}

function definedOnly(info: AttributionInfo): AttributionInfo {
  return Object.fromEntries(
    Object.entries(info).filter(([, value]) => value !== undefined && value !== null),
  ) as AttributionInfo
}

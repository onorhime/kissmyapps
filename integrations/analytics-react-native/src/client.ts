// The KissMyApps app client, with no React Native in it: the app's storage, device and
// network come in through `Environment`, so the same code runs in tests and in Node.
// The Android and iOS SDKs follow the same rules; see integrations/analytics-mobile.

export const SDK_VERSION = '1.0.0'
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
  debug?: boolean
}

export interface Environment {
  storage: Storage | null
  device(): DeviceInfo
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>
  sdk: string
  now?: () => number
  log?: (message: string) => void
}

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
    })
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
      this.inForeground = true
      this.foregroundAt = this.now()
      if (this.state.optedOut) return
      const session = this.ensureSession()
      if (this.options.trackLifecycle !== false) {
        if (launch) this.recordInstallOrUpdate(session)
        this.enqueue('app_opened', { from_background: !launch }, session)
      }
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

  private async post(body: Properties) {
    return this.env.fetch(`${this.options.endpoint}/v1/events`, {
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

  private warn(message: string): void {
    if (this.options.debug) (this.env.log ?? console.warn)(`KissMyApps: ${message}`)
  }
}

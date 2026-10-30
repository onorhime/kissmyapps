import { parseUserAgent, type DeviceInfo, type HighEntropyHints } from './device'

export const SDK_VERSION = '1.0.0'
export const DEFAULT_ENDPOINT = 'https://events.kissmyapps.dev'

export type Properties = Record<string, unknown>

export interface ReplayRecorder {
  stop(): void
  takeFullSnapshot(): void
}

export interface ReplayModule {
  start(emit: (event: { timestamp: number }) => void): ReplayRecorder
}

export interface KmaOptions {
  /** The project's client key, kma_pk_live_… or kma_pk_test_…. */
  key: string
  endpoint?: string
  /** Record session replays (inputs are always masked). Default true. */
  replay?: boolean
  /** Share of sessions to record, 0 to 1. Default 1. */
  replaySampleRate?: number
  autoPageViews?: boolean
  captureErrors?: boolean
  sessionTimeoutMinutes?: number
  appVersion?: string
  /** Where the replay recorder script is, for the script-tag build. */
  replayScriptUrl?: string
  loadReplay?: () => Promise<ReplayModule>
  fetch?: typeof fetch
  debug?: boolean
}

interface Session {
  id: string
  started: number
  last: number
  interactions: number
  landing: string
  referrer?: string
  utm?: Record<string, string>
  replay: boolean
}

interface QueuedEvent {
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

interface State {
  anonymousId: string
  userId: string | null
  traits: Properties | null
  session: Session | null
  optedOut: boolean
  replayOffUntil: number
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/
const MAX_QUEUE = 1000
const BATCH_SIZE = 50
const FLUSH_MS = 2000
const HEARTBEAT_MS = 60_000
const REPLAY_FLUSH_MS = 5000
// The page's first snapshot goes out soon after load, so a short visit to a page of a
// multi-page site still has it: on page hide only about 60 kB can be handed to the browser.
const REPLAY_FIRST_FLUSH_MS = 1000
const BEACON_BYTES = 60_000
const REPLAY_CHUNK_BYTES = 300_000
const REPLAY_MAX_BYTES = 3_500_000
const MAX_ERRORS_PER_PAGE = 20

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function storageGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function storageSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the SDK keeps working in memory.
  }
}

function currentScreen(): string {
  const { pathname, hash } = window.location
  return hash.startsWith('#/') || hash.startsWith('#!') ? pathname + hash : pathname
}

function externalReferrer(): string | undefined {
  try {
    if (!document.referrer) return undefined
    const referrer = new URL(document.referrer)
    return referrer.host === window.location.host ? undefined : document.referrer.slice(0, 500)
  } catch {
    return undefined
  }
}

function utmFromUrl(): Record<string, string> | undefined {
  const params = new URLSearchParams(window.location.search)
  const utm: Record<string, string> = {}
  for (const key of ['source', 'medium', 'campaign', 'term', 'content']) {
    const value = params.get(`utm_${key}`)
    if (value) utm[key] = value.slice(0, 200)
  }
  return Object.keys(utm).length ? utm : undefined
}

export class Kma {
  readonly options: Required<Pick<KmaOptions, 'key' | 'endpoint'>> & KmaOptions
  private state: State
  private queue: QueuedEvent[]
  private readonly storageKey: string
  private device: DeviceInfo
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  private failures = 0
  private lastSent = 0
  // identify or setTraits ran and nothing has carried the change to the server yet.
  private identityPending = false
  private lastScreen: string | null = null
  private errorsThisPage = 0
  private lastScroll = 0
  private recorder: ReplayRecorder | null = null
  private replayBuffer: { timestamp: number }[] = []
  private replayBytes = 0
  private replaySession: Session | null = null
  private replayTimer: ReturnType<typeof setInterval> | null = null
  private replayKickoff: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly cleanup: (() => void)[] = []

  constructor(options: KmaOptions) {
    if (!/^kma_pk_(live|test)_[A-Za-z0-9]{20,64}$/.test(options.key ?? '')) {
      throw new Error('KissMyApps: init needs a client key that starts with kma_pk_')
    }
    this.options = {
      ...options,
      endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    }
    this.storageKey = `kma:${options.key.slice(-8)}`
    const saved = storageGet<State>(this.storageKey)
    this.state = {
      anonymousId: saved?.anonymousId ?? uuid(),
      userId: saved?.userId ?? null,
      traits: saved?.traits ?? null,
      session: saved?.session ?? null,
      optedOut: saved?.optedOut ?? false,
      replayOffUntil: saved?.replayOffUntil ?? 0,
    }
    this.queue = storageGet<QueuedEvent[]>(`${this.storageKey}:queue`) ?? []
    this.device = parseUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0)
    this.persist()
    this.readClientHints()
    this.listen()
    this.ensureSession()
    if (this.options.autoPageViews !== false) this.page()
    this.startReplay()
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    if (this.queue.length) this.scheduleFlush(0)
  }

  /** Records something a person did. */
  track(
    name: string,
    properties: Properties = {},
    options: { time?: Date; insertId?: string } = {},
  ): void {
    if (this.stopped || this.state.optedOut) return
    if (!EVENT_NAME.test(name)) {
      this.warn(`"${name}" is not a valid event name: use letters, numbers and _ . : - (up to 80).`)
      return
    }
    const session = this.ensureSession()
    this.enqueue(name, properties, session, options)
  }

  /** Records a page or screen view. Called automatically when the URL changes. */
  page(properties: Properties = {}): void {
    const screen = currentScreen()
    this.lastScreen = screen
    this.track('page_viewed', {
      title: document.title.slice(0, 200),
      path: window.location.pathname,
      ...properties,
    })
  }

  /** Ties this device to your own user ID, with optional traits such as email, name or plan. */
  identify(userId: string | number, traits?: Properties): void {
    const id = String(userId).trim()
    if (!id || id.length > 200) {
      this.warn('identify needs a user ID of 1 to 200 characters.')
      return
    }
    this.state.userId = id
    if (traits) this.state.traits = { ...(this.state.traits ?? {}), ...traits }
    this.identityPending = true
    this.persist()
    this.scheduleFlush(0)
  }

  /** Updates traits for the current person without changing who they are. */
  setTraits(traits: Properties): void {
    this.state.traits = { ...(this.state.traits ?? {}), ...traits }
    this.identityPending = true
    this.persist()
    this.scheduleFlush(0)
  }

  /** Forgets the user, for example on sign out: the next events start a new anonymous person and session. */
  reset(): void {
    void this.flush()
    this.state.userId = null
    this.state.traits = null
    this.identityPending = false
    this.state.anonymousId = uuid()
    this.state.session = null
    this.persist()
    this.ensureSession()
  }

  optOut(): void {
    this.state.optedOut = true
    this.queue = []
    this.stopRecorder()
    this.persist()
  }

  optIn(): void {
    this.state.optedOut = false
    this.persist()
    this.startReplay()
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
    if (this.inflight) return this.inflight
    this.inflight = this.sendQueued().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  shutdown(): void {
    this.stopped = true
    this.stopRecorder()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const undo of this.cleanup) undo()
  }

  // Sessions -----------------------------------------------------------------------------

  private ensureSession(): Session {
    const now = Date.now()
    const timeout = (this.options.sessionTimeoutMinutes ?? 30) * 60_000
    let session = this.state.session
    if (!session || now - session.last > timeout) {
      const sampled = Math.random() < (this.options.replaySampleRate ?? 1)
      session = {
        id: uuid(),
        started: now,
        last: now,
        interactions: 0,
        landing: currentScreen(),
        referrer: externalReferrer(),
        utm: utmFromUrl(),
        replay: sampled,
      }
      this.state.session = session
      this.persist()
      this.enqueue(
        'session_started',
        { landing: session.landing, referrer: session.referrer ?? null },
        session,
        {},
      )
      this.onNewSession(session)
    } else {
      session.last = now
    }
    return session
  }

  private enqueue(
    name: string,
    properties: Properties,
    session: Session,
    options: { time?: Date; insertId?: string },
  ): void {
    const event: QueuedEvent = {
      name,
      insert_id: options.insertId ?? uuid(),
      time: (options.time ?? new Date()).toISOString(),
      screen: name === 'session_started' ? session.landing : currentScreen(),
      properties: this.cleanProperties(properties),
      user_id: this.state.userId,
      anonymous_id: this.state.anonymousId,
      session_id: session.id,
      session_started_at: new Date(session.started).toISOString(),
    }
    this.queue.push(event)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    this.persistQueue()
    this.persist()
    this.scheduleFlush(this.queue.length >= BATCH_SIZE ? 0 : FLUSH_MS)
  }

  private cleanProperties(properties: Properties): Properties {
    try {
      const json = JSON.stringify(properties ?? {})
      if (json.length > 32_000) {
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
    const screenInfo = typeof screen !== 'undefined' ? screen : undefined
    return {
      platform: 'web',
      sdk: `kma-web/${SDK_VERSION}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      ...this.device,
      screen_width: screenInfo?.width,
      screen_height: screenInfo?.height,
      app_version: this.options.appVersion,
      page_path: session?.landing ?? currentScreen(),
      referrer: session?.referrer,
      utm: session?.utm,
      interactions: session?.interactions ?? 0,
      webdriver: navigator.webdriver === true,
    }
  }

  /** One request's body: queued events share a device and session; with none, a heartbeat. */
  private body(events: QueuedEvent[], extra: Properties = {}): Properties {
    const head = events[0]
    const session = this.state.session
    const sessionId = head?.session_id ?? session?.id
    const startedAt =
      head?.session_started_at ?? (session ? new Date(session.started).toISOString() : undefined)
    const live = session?.id === sessionId ? session : null
    const current = !head || head.anonymous_id === this.state.anonymousId
    return {
      anonymous_id: head?.anonymous_id ?? this.state.anonymousId,
      user_id: (current ? this.state.userId : events[events.length - 1].user_id) ?? undefined,
      traits: (current && this.state.traits) || undefined,
      session: sessionId ? { id: sessionId, started_at: startedAt } : undefined,
      sent_at: new Date().toISOString(),
      context: this.context(live),
      events: events.map(({ name, insert_id, time, screen, properties, user_id }) => ({
        name,
        insert_id,
        time,
        screen,
        properties,
        user_id,
      })),
      ...extra,
    }
  }

  private async post(path: string, body: Properties): Promise<Response> {
    const json = JSON.stringify(body)
    const send = this.options.fetch ?? fetch
    return send(`${this.options.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.key}` },
      body: json,
      keepalive: json.length < 60_000,
      credentials: 'omit',
    })
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

  private async sendQueued(): Promise<void> {
    while (!this.stopped && !this.state.optedOut) {
      const batch = this.nextBatch()
      if (!batch.length && !(this.identityPending && this.state.session)) return
      const traitsSent = this.state.traits
      const carriesIdentity = !batch.length || batch[0].anonymous_id === this.state.anonymousId
      let response: Response
      try {
        response = await this.post('/v1/events', this.body(batch))
      } catch {
        this.retryLater()
        return
      }
      if (
        response.ok ||
        (response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429)
      ) {
        if (!response.ok)
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
        this.lastSent = Date.now()
        this.persistQueue()
        this.persist()
      } else {
        this.retryLater()
        return
      }
    }
  }

  private retryLater(): void {
    this.failures += 1
    this.scheduleFlush(Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6)))
  }

  private scheduleFlush(delay: number): void {
    if (this.stopped) return
    if (this.flushTimer) {
      if (delay > 0) return
      clearTimeout(this.flushTimer)
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay)
  }

  /** On page hide, hand what is queued to the browser so it is sent after the page closes. */
  private beacon(): void {
    if (this.state.optedOut || !this.queue.length) return
    const url = `${this.options.endpoint}/v1/events`
    while (this.queue.length) {
      const batch = this.nextBatch()
      const json = JSON.stringify({ ...this.body(batch), api_key: this.options.key })
      const ok =
        typeof navigator.sendBeacon === 'function' &&
        json.length < BEACON_BYTES &&
        navigator.sendBeacon(url, new Blob([json], { type: 'text/plain' }))
      if (!ok) break
      const sent = new Set(batch.map((event) => event.insert_id))
      this.queue = this.queue.filter((event) => !sent.has(event.insert_id))
    }
    this.persistQueue()
  }

  /** Keeps an open, recently used page counted as online. */
  private heartbeat(): void {
    const session = this.state.session
    if (this.stopped || this.state.optedOut || !session || document.visibilityState === 'hidden')
      return
    const timeout = (this.options.sessionTimeoutMinutes ?? 30) * 60_000
    if (Date.now() - session.last > timeout) return
    if (this.queue.length || this.identityPending) {
      void this.flush()
      return
    }
    if (Date.now() - this.lastSent < HEARTBEAT_MS - 1000) return
    this.post('/v1/events', this.body([]))
      .then(() => {
        this.lastSent = Date.now()
      })
      .catch(() => undefined)
  }

  // Page listeners -----------------------------------------------------------------------

  private listen(): void {
    const on = <K extends keyof WindowEventMap>(
      type: K,
      handler: (event: WindowEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      window.addEventListener(type, handler, options)
      this.cleanup.push(() => window.removeEventListener(type, handler, options))
    }
    const interacted = () => {
      const session = this.state.session
      if (!session) return
      const timeout = (this.options.sessionTimeoutMinutes ?? 30) * 60_000
      if (Date.now() - session.last > timeout) this.ensureSession()
      else session.last = Date.now()
      this.state.session!.interactions += 1
    }
    on('pointerdown', interacted, { capture: true, passive: true })
    on('keydown', interacted, { capture: true, passive: true })
    on(
      'scroll',
      () => {
        if (Date.now() - this.lastScroll < 2000) return
        this.lastScroll = Date.now()
        interacted()
      },
      { capture: true, passive: true },
    )
    // Events first: they and the replay share the browser's small allowance for page hide.
    on('pagehide', () => {
      this.persist()
      this.beacon()
      this.flushReplay(true)
    })
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        this.persist()
        this.beacon()
        this.flushReplay(true)
      }
    }
    document.addEventListener('visibilitychange', visibility)
    this.cleanup.push(() => document.removeEventListener('visibilitychange', visibility))

    if (this.options.autoPageViews !== false) {
      const changed = () => {
        const screen = currentScreen()
        if (screen !== this.lastScreen) this.page()
      }
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method]
        const patched = function (this: History, ...args: Parameters<History['pushState']>) {
          const result = original.apply(this, args)
          queueMicrotask(changed)
          return result
        }
        history[method] = patched
        this.cleanup.push(() => {
          if (history[method] === patched) history[method] = original
        })
      }
      on('popstate', changed)
      on('hashchange', changed)
    }

    if (this.options.captureErrors !== false) {
      on('error', (event) => {
        if (this.errorsThisPage++ >= MAX_ERRORS_PER_PAGE || !event.message) return
        this.track('error_thrown', {
          message: String(event.message).slice(0, 300),
          source: event.filename ? String(event.filename).slice(0, 300) : null,
          line: event.lineno ?? null,
          column: event.colno ?? null,
          kind: 'error',
        })
      })
      on('unhandledrejection', (event) => {
        if (this.errorsThisPage++ >= MAX_ERRORS_PER_PAGE) return
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
        this.track('error_thrown', { message: reason.slice(0, 300), kind: 'unhandled_rejection' })
      })
    }
  }

  private readClientHints(): void {
    const data = (
      navigator as Navigator & {
        userAgentData?: { getHighEntropyValues?(hints: string[]): Promise<HighEntropyHints> }
      }
    ).userAgentData
    data
      ?.getHighEntropyValues?.(['platformVersion', 'model', 'fullVersionList'])
      .then((hints) => {
        this.device = parseUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0, hints)
      })
      .catch(() => undefined)
  }

  // Session replay -----------------------------------------------------------------------

  private onNewSession(session: Session): void {
    if (!this.recorder) return
    this.flushReplay(false)
    this.replaySession = session
    if (!session.replay) {
      this.stopRecorder()
      return
    }
    this.recorder.takeFullSnapshot()
  }

  private startReplay(): void {
    if (this.options.replay === false || this.recorder || this.state.optedOut) return
    if (Date.now() < this.state.replayOffUntil) return
    // Automated browsers are left out of reports, so their visits are not recorded.
    if (navigator.webdriver) return
    const session = this.ensureSession()
    if (!session.replay) return
    const load =
      this.options.loadReplay ??
      (() =>
        new Promise<ReplayModule>((resolve, reject) => {
          const existing = (window as Window & { __kmaReplay?: ReplayModule }).__kmaReplay
          if (existing) return resolve(existing)
          if (!this.options.replayScriptUrl) return reject(new Error('no replay script'))
          const script = document.createElement('script')
          script.src = this.options.replayScriptUrl
          script.async = true
          script.onload = () => {
            const module = (window as Window & { __kmaReplay?: ReplayModule }).__kmaReplay
            if (module) resolve(module)
            else reject(new Error('replay script did not load'))
          }
          script.onerror = () => reject(new Error('replay script did not load'))
          document.head.appendChild(script)
        }))
    load()
      .then((module) => {
        if (this.stopped || this.recorder || this.state.optedOut) return
        this.replaySession = this.state.session
        this.recorder = module.start((event) => {
          this.replayBuffer.push(event)
          this.replayBytes += JSON.stringify(event).length
          if (this.replayBytes > REPLAY_CHUNK_BYTES) this.flushReplay(false)
        })
        this.replayKickoff = setTimeout(() => this.flushReplay(false), REPLAY_FIRST_FLUSH_MS)
        this.replayTimer = setInterval(() => this.flushReplay(false), REPLAY_FLUSH_MS)
      })
      .catch(() => this.warn('Session replay could not start.'))
  }

  private stopRecorder(): void {
    this.recorder?.stop()
    this.recorder = null
    if (this.replayTimer) clearInterval(this.replayTimer)
    if (this.replayKickoff) clearTimeout(this.replayKickoff)
    this.replayTimer = null
    this.replayKickoff = null
    this.replayBuffer = []
    this.replayBytes = 0
  }

  private flushReplay(closing: boolean): void {
    const session = this.replaySession
    if (!this.replayBuffer.length || !session || this.state.optedOut) return
    const events = this.replayBuffer
    const bytes = this.replayBytes
    this.replayBuffer = []
    this.replayBytes = 0
    if (bytes > REPLAY_MAX_BYTES) {
      this.warn('A replay chunk was too large to send and was skipped.')
      return
    }
    if (closing && bytes > BEACON_BYTES) return
    const seq = Math.max(0, Math.round(events[0].timestamp - session.started))
    const body = {
      anonymous_id: this.state.anonymousId,
      user_id: this.state.userId ?? undefined,
      session: { id: session.id, started_at: new Date(session.started).toISOString() },
      sent_at: new Date().toISOString(),
      context: this.context(session),
      replay: {
        seq,
        first_ts: events[0].timestamp,
        last_ts: events[events.length - 1].timestamp,
        events,
      },
    }
    if (closing) {
      // A request with headers needs a preflight, which the browser drops once the page is
      // gone, so the last part goes as a plain beacon with the key in the body.
      if (typeof navigator.sendBeacon === 'function') {
        const json = JSON.stringify({ ...body, api_key: this.options.key })
        if (json.length < BEACON_BYTES)
          navigator.sendBeacon(
            `${this.options.endpoint}/v1/replay`,
            new Blob([json], { type: 'text/plain' }),
          )
      }
      return
    }
    this.post('/v1/replay', body)
      .then((response) => {
        if (response.status === 409) {
          // Replay is off for this project: stop recording for a day.
          this.state.replayOffUntil = Date.now() + 24 * 60 * 60 * 1000
          this.persist()
          this.stopRecorder()
        } else if (response.status === 413) {
          session.replay = false
          this.persist()
          this.stopRecorder()
        }
      })
      .catch(() => undefined)
  }

  // Storage ------------------------------------------------------------------------------

  private persist(): void {
    storageSet(this.storageKey, this.state)
  }

  private persistQueue(): void {
    storageSet(`${this.storageKey}:queue`, this.queue)
  }

  private warn(message: string): void {
    if (this.options.debug !== false) console.warn(`KissMyApps: ${message}`)
  }
}

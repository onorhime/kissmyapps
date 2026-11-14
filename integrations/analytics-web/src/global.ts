import { Kma, type Attribution, type KmaOptions, type Properties, type RevenueOptions } from './kma'

type Call = [method: string, ...args: unknown[]]
type Stub = ((...args: unknown[]) => void) & { q?: IArguments[] | Call[] }

interface Global {
  (method: string, ...args: unknown[]): void
  init(key: string, options?: Omit<KmaOptions, 'key'>): Kma
  track(name: string, properties?: Properties): void
  /** A payment in major units (negative for a refund) and its ISO 4217 currency code. */
  revenue(amount: number, currency: string, options?: RevenueOptions): void
  page(properties?: Properties): void
  identify(userId: string | number, traits?: Properties): void
  setTraits(traits: Properties): void
  reset(): void
  optOut(): void
  optIn(): void
  flush(): Promise<void>
  /** Undefined until the script has loaded. */
  attribution(): Attribution | null | undefined
  /** Before the script has loaded, the link as given. */
  appLink(url: string): string
  /** The creator click to put in your Stripe payment's metadata, or null. Never waits. */
  getClickId(): string | null
  instance: Kma | null
}

const script = document.currentScript as HTMLScriptElement | null
const scriptUrl = script?.src ? new URL(script.src, window.location.href) : null
const pending: Call[] = []
const existing = (window as Window & { kma?: Stub }).kma
for (const call of existing?.q ?? []) pending.push(Array.from(call as ArrayLike<unknown>) as Call)

let instance: Kma | null = null
const methods = [
  'track',
  'revenue',
  'page',
  'identify',
  'setTraits',
  'reset',
  'optOut',
  'optIn',
  'flush',
  'attribution',
  'appLink',
  'getClickId',
] as const

function call(method: string, ...args: unknown[]): unknown {
  if (method === 'init') return init(args[0] as string, args[1] as Omit<KmaOptions, 'key'>)
  if (!instance) {
    // Reading calls answer at once: there is nothing to read yet.
    if (method === 'appLink') return args[0]
    if (method === 'attribution') return undefined
    if (method === 'getClickId') return null
    // Kept until init; a page whose key is wrong never grows this without bound.
    if (pending.length < 200) pending.push([method, ...args])
    return undefined
  }
  const fn = (instance as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
  if (typeof fn !== 'function') {
    console.warn(`KissMyApps: unknown method ${method}`)
    return undefined
  }
  return fn.apply(instance, args)
}

function init(key: string, options: Omit<KmaOptions, 'key'> = {}): Kma {
  if (instance) return instance
  instance = new Kma({
    replayScriptUrl: scriptUrl ? new URL('kma-replay.js', scriptUrl).href : undefined,
    ...options,
    key,
  })
  for (const [method, ...args] of pending.splice(0)) call(method, ...args)
  api.instance = instance
  return instance
}

const api = Object.assign((method: string, ...args: unknown[]) => void call(method, ...args), {
  init,
  instance: null as Kma | null,
}) as unknown as Global
for (const method of methods) {
  ;(api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
    call(method, ...args)
}
// <script … data-attribution="session"> keeps sources for the visit only; "off" reads none.
const attributionMode = (value?: string) =>
  value === 'session' || value === 'off' || value === 'full' ? value : undefined
;(window as unknown as { kma: Global }).kma = api

// A wrong key is reported in the console instead of throwing on the merchant's page.
function start(key: string, options: Omit<KmaOptions, 'key'>) {
  try {
    init(key, options)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
}

// <script src=".../kma.js" data-key="kma_pk_live_…" data-endpoint="…" data-replay="false">
const key = script?.dataset.key
if (key) {
  start(key, {
    endpoint: script?.dataset.endpoint || undefined,
    replay: script?.dataset.replay !== 'false',
    appVersion: script?.dataset.appVersion || undefined,
    attribution: attributionMode(script?.dataset.attribution),
  })
} else if (pending.some(([method]) => method === 'init')) {
  const index = pending.findIndex(([method]) => method === 'init')
  const [[, initKey, initOptions]] = pending.splice(index, 1)
  start(initKey as string, (initOptions ?? {}) as Omit<KmaOptions, 'key'>)
}

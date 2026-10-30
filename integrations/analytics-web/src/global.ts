import { Kma, type KmaOptions, type Properties } from './kma'

type Call = [method: string, ...args: unknown[]]
type Stub = ((...args: unknown[]) => void) & { q?: IArguments[] | Call[] }

interface Global {
  (method: string, ...args: unknown[]): void
  init(key: string, options?: Omit<KmaOptions, 'key'>): Kma
  track(name: string, properties?: Properties): void
  page(properties?: Properties): void
  identify(userId: string | number, traits?: Properties): void
  setTraits(traits: Properties): void
  reset(): void
  optOut(): void
  optIn(): void
  flush(): Promise<void>
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
  'page',
  'identify',
  'setTraits',
  'reset',
  'optOut',
  'optIn',
  'flush',
] as const

function call(method: string, ...args: unknown[]): unknown {
  if (method === 'init') return init(args[0] as string, args[1] as Omit<KmaOptions, 'key'>)
  if (!instance) {
    pending.push([method, ...args])
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
;(window as unknown as { kma: Global }).kma = api

// <script src=".../kma.js" data-key="kma_pk_live_…" data-endpoint="…" data-replay="false">
const key = script?.dataset.key
if (key) {
  init(key, {
    endpoint: script?.dataset.endpoint || undefined,
    replay: script?.dataset.replay !== 'false',
    appVersion: script?.dataset.appVersion || undefined,
  })
} else if (pending.some(([method]) => method === 'init')) {
  const index = pending.findIndex(([method]) => method === 'init')
  const [[, initKey, initOptions]] = pending.splice(index, 1)
  init(initKey as string, initOptions as Omit<KmaOptions, 'key'>)
}

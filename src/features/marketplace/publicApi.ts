import { projectBaseUrl, readProgramDetail, readProgramList, record } from './model'
import { isProgramSlug } from './routing'
import type { MarketplaceProgram, MarketplaceProgramDetail } from './model'

/**
 * The public marketplace reads one public function with plain GET requests: no session, no
 * key, no cookies, no body. Nothing about the visitor is sent.
 */

export type MarketplaceFailure = 'offline' | 'unavailable'

export type MarketplaceLoad<T> =
  | { status: 'ready'; data: T }
  | { status: 'not-found' }
  | { status: 'error'; reason: MarketplaceFailure }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface MarketplaceApiOptions {
  baseUrl?: string | null
  fetch?: Fetch
  signal?: AbortSignal
}

function endpoint(baseUrl: string, slug?: string): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/functions/v1/marketplace`
  return slug ? `${url}?slug=${encodeURIComponent(slug)}` : url
}

function failure(): { status: 'error'; reason: MarketplaceFailure } {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return { status: 'error', reason: offline ? 'offline' : 'unavailable' }
}

async function get(url: string, options: MarketplaceApiOptions): Promise<Response | null> {
  try {
    return await (options.fetch ?? fetch)(url, {
      method: 'GET',
      credentials: 'omit',
      signal: options.signal,
    })
  } catch (problem) {
    if (problem instanceof DOMException && problem.name === 'AbortError') throw problem
    return null
  }
}

export async function loadMarketplacePrograms(
  options: MarketplaceApiOptions = {},
): Promise<MarketplaceLoad<MarketplaceProgram[]>> {
  const baseUrl = options.baseUrl === undefined ? projectBaseUrl() : options.baseUrl
  if (!baseUrl) return { status: 'error', reason: 'unavailable' }
  const response = await get(endpoint(baseUrl), options)
  if (!response) return failure()
  if (!response.ok) return { status: 'error', reason: 'unavailable' }
  try {
    return { status: 'ready', data: readProgramList(await response.json()) }
  } catch {
    return { status: 'error', reason: 'unavailable' }
  }
}

export async function loadMarketplaceProgram(
  slug: string,
  options: MarketplaceApiOptions = {},
): Promise<MarketplaceLoad<MarketplaceProgramDetail>> {
  if (!isProgramSlug(slug)) return { status: 'not-found' }
  const baseUrl = options.baseUrl === undefined ? projectBaseUrl() : options.baseUrl
  if (!baseUrl) return { status: 'error', reason: 'unavailable' }
  const response = await get(endpoint(baseUrl, slug), options)
  if (!response) return failure()
  if (response.status === 404) return { status: 'not-found' }
  if (!response.ok) return { status: 'error', reason: 'unavailable' }
  try {
    const body = record(await response.json())
    if (body && body.program === null) return { status: 'not-found' }
    return { status: 'ready', data: readProgramDetail(body?.program) }
  } catch {
    return { status: 'error', reason: 'unavailable' }
  }
}

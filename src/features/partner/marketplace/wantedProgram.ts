import { isProgramSlug } from '../../marketplace/routing'

/**
 * A visitor who presses "Join program" on the public marketplace arrives signed out. The
 * program they wanted is kept in this browser while they sign in, or register and confirm
 * their email (which can open a new tab), and they are taken to it afterwards. Only the
 * program's slug and the time are stored.
 */

const storageKey = 'kma:partner:wanted-program'
const ttl = 24 * 60 * 60 * 1000

export function rememberWantedProgram(slug: string, now = Date.now()): void {
  if (!isProgramSlug(slug)) return
  try {
    localStorage.setItem(storageKey, JSON.stringify({ slug, expiresAt: now + ttl }))
  } catch {
    /* Private browsing can disable storage; the visitor then lands on the dashboard. */
  }
}

export function peekWantedProgram(now = Date.now()): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as {
      slug?: unknown
      expiresAt?: unknown
    } | null
    if (
      saved &&
      isProgramSlug(saved.slug) &&
      typeof saved.expiresAt === 'number' &&
      saved.expiresAt > now
    )
      return saved.slug
    if (saved) localStorage.removeItem(storageKey)
  } catch {
    /* Nothing usable was stored. */
  }
  return null
}

export function clearWantedProgram(): void {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    /* No stored state. */
  }
}

/** Reads the wanted program once: after this the visitor is on their way to it. */
export function takeWantedProgram(now = Date.now()): string | null {
  const slug = peekWantedProgram(now)
  if (slug) clearWantedProgram()
  return slug
}

/** `?program=speaksix`, as the public page's Sign in and Become a creator links carry it. */
export function wantedProgramFromSearch(search: string): string | null {
  const slug = new URLSearchParams(search).get('program')
  return isProgramSlug(slug) ? slug : null
}

/** The address with `?program=` removed, so it is not kept in history or shared by accident. */
export function wantedProgramClearedUrl(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  const params = new URLSearchParams(location.search)
  params.delete('program')
  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
}

/**
 * The public marketplace lives at /marketplace and /marketplace/<slug> on every host the
 * dashboard is served from. The partner dashboard shows the same programs at #marketplace
 * and #marketplace/<slug>.
 */

export type MarketplaceRoute =
  { name: 'list' } | { name: 'program'; slug: string } | { name: 'not-found' }

const PARTNER_HOST = 'partners.kissmyapps.dev'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The same rule the public function applies before it looks a program up. */
export function isProgramSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && SLUG.test(value)
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

export function isMarketplacePath(pathname: string): boolean {
  return segments(pathname)[0] === 'marketplace'
}

export function marketplaceRouteFromPath(pathname: string): MarketplaceRoute {
  const [root, slug, ...rest] = segments(pathname)
  if (root !== 'marketplace' || rest.length > 0) return { name: 'not-found' }
  if (slug === undefined) return { name: 'list' }
  return isProgramSlug(slug) ? { name: 'program', slug } : { name: 'not-found' }
}

export function marketplacePath(slug?: string): string {
  return slug ? `/marketplace/${slug}` : '/marketplace'
}

/** `#marketplace/speaksix` → "speaksix". Null for the list and for anything malformed. */
export function programSlugFromHash(hash: string): string | null {
  const [root, slug, ...rest] = hash.replace(/^#/, '').split('/')
  if (root !== 'marketplace' || rest.length > 0) return null
  return isProgramSlug(slug) ? slug : null
}

export function marketplaceHash(slug?: string | null): string {
  return slug ? `#marketplace/${slug}` : '#marketplace'
}

/**
 * Where the partner dashboard is, seen from the page being shown. On kissmyapps.dev and its
 * subdomains that is the partner host; anywhere else (local development, a preview) the same
 * origin serves the dashboard at its root.
 */
export function partnerAppOrigin(location: Pick<Location, 'hostname' | 'origin'>): string {
  const hostname = location.hostname.trim().toLowerCase().replace(/\.$/, '')
  return hostname === 'kissmyapps.dev' || hostname.endsWith('.kissmyapps.dev')
    ? `https://${PARTNER_HOST}`
    : location.origin
}

/**
 * A link into the partner dashboard. `join` opens that program's agreement; a signed-out
 * visitor signs in or registers first and is then taken to it. `screen` opens sign-in or
 * registration directly, carrying the wanted program along.
 */
export function partnerAppUrl(
  location: Pick<Location, 'hostname' | 'origin'>,
  target: { join?: string | null; screen?: 'sign-in' | 'sign-up' } = {},
): string {
  const url = new URL('/', partnerAppOrigin(location))
  if (target.screen) {
    if (target.join) url.searchParams.set('program', target.join)
    url.hash = `auth/${target.screen}`
  } else if (target.join) {
    url.hash = `marketplace/${target.join}`
  }
  return url.toString()
}

import { isMerchantRoute } from '../features/merchant-connections/routing'

const workspaceHosts = new Set(['partners.kissmyapps.dev', 'admin.kissmyapps.dev'])

/**
 * The merchant console lives on its own subdomain (merchant.kissmyapps.dev in
 * production, merchant.localhost locally). Outside the two existing workspace
 * hosts, `?app=merchant` also opens it so previews can reach it without DNS.
 * The Stripe merchant-connect pages keep their own paths on every host.
 */
export function isMerchantConsole(
  location: Pick<Location, 'hostname' | 'pathname' | 'search'>,
): boolean {
  if (isMerchantRoute(location.pathname)) return false
  const hostname = location.hostname.trim().toLowerCase().replace(/\.$/, '')
  if (hostname.startsWith('merchant.')) return true
  if (workspaceHosts.has(hostname)) return false
  return new URLSearchParams(location.search).get('app') === 'merchant'
}

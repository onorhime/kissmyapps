export type Workspace = 'partner' | 'admin'

const adminHostname = 'admin.kissmyapps.dev'
const partnerHostname = 'partners.kissmyapps.dev'
const partnerRoutes = new Set(['performance', 'payouts', 'links', 'profile'])

function routePrefix(hash: string): string {
  return hash.replace(/^#/, '').split('/')[0]?.toLowerCase() ?? ''
}

/**
 * Returns a workspace only when the hash explicitly names one. Authentication
 * routes intentionally return null so they can retain the workspace that sent
 * the user to sign-in, recovery, or invitation setup.
 */
export function explicitWorkspaceFromHash(hash: string): Workspace | null {
  const prefix = routePrefix(hash)
  if (prefix === 'admin') return 'admin'
  if (partnerRoutes.has(prefix)) return 'partner'
  return null
}

export function defaultWorkspaceForHostname(hostname: string): Workspace {
  return productionWorkspaceForHostname(hostname) ?? 'partner'
}

export function productionWorkspaceForHostname(hostname: string): Workspace | null {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (normalizedHostname === adminHostname) return 'admin'
  if (normalizedHostname === partnerHostname) return 'partner'
  return null
}

export function initialWorkspace({
  hash,
  hostname,
  previewMode,
}: {
  hash: string
  hostname: string
  previewMode: boolean
}): Workspace {
  // Preview and local development keep hash-based workspace switching. On the
  // two production hosts, the hostname is the security and presentation
  // boundary and a stale fragment must never select the other shell.
  const productionWorkspace = productionWorkspaceForHostname(hostname)
  if (productionWorkspace) return productionWorkspace

  if (previewMode) return explicitWorkspaceFromHash(hash) ?? 'partner'

  const explicitWorkspace = explicitWorkspaceFromHash(hash)
  if (explicitWorkspace) return explicitWorkspace

  return defaultWorkspaceForHostname(hostname)
}

export function canonicalWorkspaceHash({
  hash,
  hostname,
}: {
  hash: string
  hostname: string
}): '#admin/overview' | '#performance' | null {
  const productionWorkspace = productionWorkspaceForHostname(hostname)
  const explicitWorkspace = explicitWorkspaceFromHash(hash)
  if (!productionWorkspace || !explicitWorkspace || productionWorkspace === explicitWorkspace) {
    return null
  }

  return productionWorkspace === 'admin' ? '#admin/overview' : '#performance'
}

export function productionWorkspaceUrl(
  workspace: Workspace,
  location?: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  const hostname = workspace === 'admin' ? adminHostname : partnerHostname
  const url = new URL(`https://${hostname}/`)

  if (location) {
    url.pathname = location.pathname
    url.search = location.search
    url.hash = location.hash
  } else {
    url.hash = workspace === 'admin' ? 'admin/overview' : 'performance'
  }

  return url.toString()
}

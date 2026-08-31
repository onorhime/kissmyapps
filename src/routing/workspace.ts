export type Workspace = 'partner' | 'admin'

const adminHostname = 'admin.kissmyapps.dev'
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
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '')
  return normalizedHostname === adminHostname ? 'admin' : 'partner'
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
  const explicitWorkspace = explicitWorkspaceFromHash(hash)
  if (explicitWorkspace) return explicitWorkspace

  // The UI showroom and test harness have always opened on the partner sample.
  // Production hostname defaults only apply to the real authenticated app.
  return previewMode ? 'partner' : defaultWorkspaceForHostname(hostname)
}

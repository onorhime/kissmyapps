const storageKey = 'kma:merchant-connection'
const ttl = 30 * 60 * 1000

export type MerchantEntry = {
  invite: string | null
  callback: { state: string; code: string } | null
  invitationId: string | null
  error: string | null
}

export function isMerchantRoute(pathname: string): boolean {
  return pathname === '/merchant/connect' || pathname === '/merchant/callback'
}

/** Only this tab retains the invite while email verification and Stripe run. */
export function captureMerchantEntry(): MerchantEntry {
  const url = new URL(window.location.href)
  let saved: Partial<MerchantEntry> = {}
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
    if (value && value.expiresAt > Date.now()) saved = value
    else sessionStorage.removeItem(storageKey)
  } catch {
    /* Private browsing can disable storage. */
  }
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get('invite')
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const entry: MerchantEntry = {
    invite:
      token !== null
        ? /^[A-Za-z0-9_-]{32,256}$/.test(token)
          ? token
          : null
        : (saved.invite ?? null),
    callback:
      url.pathname === '/merchant/callback' &&
      state &&
      code &&
      state.length <= 256 &&
      code.length <= 512
        ? { state, code }
        : token
          ? null
          : (saved.callback ?? null),
    invitationId: token ? null : (saved.invitationId ?? null),
    error: url.searchParams.has('error')
      ? 'Stripe authorisation was cancelled. You can start again.'
      : null,
  }
  // No invite, OAuth code or state is left in browser history or referrer URLs.
  window.history.replaceState(null, '', '/merchant/connect')
  saveMerchantEntry(entry)
  return entry
}

export function saveMerchantEntry(entry: MerchantEntry): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ ...entry, expiresAt: Date.now() + ttl }))
  } catch {
    /* Continue within the current page if storage is unavailable. */
  }
}

export function clearMerchantEntry(): void {
  try {
    sessionStorage.removeItem(storageKey)
  } catch {
    /* No stored state. */
  }
}

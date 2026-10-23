const prefix = 'kma:merchant-code-request:'
const ttl = 30 * 60 * 1000
const fallback = new Map<string, { requestId: string; expiresAt: number }>()

async function storageKey(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return (
    prefix +
    Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  )
}

/** Persist the operation identity, never the invitation token, email or OTP. */
export async function invitationCodeRequestId(token: string, renew = false): Promise<string> {
  const key = await storageKey(token)
  let saved = fallback.get(key)
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (stored && /^[0-9a-f-]{36}$/i.test(stored.requestId) && Number.isFinite(stored.expiresAt))
      saved = stored
  } catch {
    // Memory fallback still prevents repeat sends on re-renders when storage is unavailable.
  }
  if (!renew && saved && saved.expiresAt > Date.now()) return saved.requestId
  const current = { requestId: crypto.randomUUID(), expiresAt: Date.now() + ttl }
  fallback.set(key, current)
  try {
    sessionStorage.setItem(key, JSON.stringify(current))
  } catch {
    /* Private browsing. */
  }
  return current.requestId
}

export async function clearInvitationCodeRequest(token: string) {
  const key = await storageKey(token)
  fallback.delete(key)
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* Private browsing. */
  }
}

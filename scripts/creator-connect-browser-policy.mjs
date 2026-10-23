/** Guards for the local-only Stripe Connect browser acceptance runner. */
export const browserOrigin = 'http://127.0.0.1:5193'
export const bridgeOrigin = 'http://127.0.0.1:5194'

export function validateTestCredentials(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['secretKey', 'publishableKey', 'platformAccountId'].includes(key),
    ) ||
    !/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(value.secretKey ?? '') ||
    !/^pk_test_[A-Za-z0-9]+$/.test(value.publishableKey ?? '') ||
    !/^acct_[A-Za-z0-9]+$/.test(value.platformAccountId ?? '')
  ) {
    throw Error('Only verified Stripe test credentials and their platform account are accepted.')
  }
  return value
}

export function allowedOnboardingRequest(address, method = 'GET') {
  const url = new URL(address)
  if (url.origin !== 'https://api.stripe.com' || url.username || url.password || url.hash)
    return false
  return method === 'GET'
    ? /^\/v1\/(account|balance|country_specs|accounts|accounts\/acct_[A-Za-z0-9]+(?:\/external_accounts)?)$/.test(
        url.pathname,
      )
    : method === 'POST' && /^\/v1\/(accounts|account_sessions)$/.test(url.pathname)
}

export function localBrowserRequestAllowed(headers, token) {
  return (
    headers.host === '127.0.0.1:5193' &&
    headers.origin === browserOrigin &&
    headers.cookie?.split(';').some((entry) => entry.trim() === `kma_creator_local=${token}`) &&
    headers['content-type']?.startsWith('application/json')
  )
}

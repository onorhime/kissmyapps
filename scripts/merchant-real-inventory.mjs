/** TEST rehearsal evidence only; never substitutes for production webhook configuration. */
export function manualMerchantInventory(input, account, status, errorCode, now = Date.now()) {
  const observed = Date.parse(input?.observedAt ?? '')
  const expires = Date.parse(input?.expiresAt ?? '')
  if (
    status !== 403 ||
    errorCode !== 'oauth_not_supported' ||
    !/^acct_[A-Za-z0-9]+$/.test(account ?? '') ||
    input?.accountId !== account ||
    input?.livemode !== false ||
    input?.method !== 'stripe-dashboard-manual' ||
    input?.totalDestinations !== 0 ||
    input?.enabledDestinations !== 0 ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now + 30000 ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 30 * 60 * 1000 ||
    now - observed > 30 * 60 * 1000 ||
    !/^\/[\s\S]+\.(png|jpg|jpeg)$/.test(input?.screenshotPath ?? '') ||
    !/^[a-f0-9]{64}$/.test(input?.screenshotSha256 ?? '') ||
    typeof input?.observation !== 'string' ||
    input.observation.trim().length < 30 ||
    input.observation.length > 2000
  )
    throw Error('Fresh exact-account manual TEST inventory evidence required.')
  return {
    accountId: account,
    livemode: false,
    method: 'stripe-dashboard-manual',
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    totalDestinations: 0,
    enabledDestinations: 0,
    screenshotPath: input.screenshotPath,
    screenshotSha256: input.screenshotSha256,
    observation: input.observation,
    apiRestriction: '403 oauth_not_supported',
    limitation:
      'Merchant webhook inventory was observed manually in Stripe Dashboard; it was not verified through the API.',
  }
}

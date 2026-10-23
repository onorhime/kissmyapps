import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateTestCredentials,
  allowedOnboardingRequest,
  localBrowserRequestAllowed,
  browserOrigin,
} from './creator-connect-browser-policy.mjs'

test('local onboarding refuses live, mismatched and extra credential inputs without exposing them', () => {
  const input = {
    secretKey: 'sk_test_fixture',
    publishableKey: 'pk_test_fixture',
    platformAccountId: 'acct_fixture',
  }
  assert.equal(validateTestCredentials(input), input)
  for (const bad of [
    { ...input, secretKey: 'sk_live_sensitive' },
    { ...input, publishableKey: 'pk_live_sensitive' },
    { ...input, owner: 'someone' },
    {},
  ]) {
    assert.throws(
      () => validateTestCredentials(bad),
      (error) => !error.message.includes('sensitive'),
    )
  }
})
test('provider bridge permits onboarding only and blocks transfers, charges, refunds and redirects', () => {
  for (const path of [
    'account',
    'balance',
    'country_specs?limit=100',
    'accounts?limit=100',
    'accounts/acct_fixture',
    'accounts/acct_fixture/external_accounts?limit=100',
  ]) {
    assert.equal(allowedOnboardingRequest(`https://api.stripe.com/v1/${path}`), true)
  }
  assert.equal(allowedOnboardingRequest('https://api.stripe.com/v1/accounts', 'POST'), true)
  assert.equal(allowedOnboardingRequest('https://api.stripe.com/v1/account_sessions', 'POST'), true)
  for (const path of [
    'transfers',
    'payouts',
    'charges',
    'refunds',
    'checkout/sessions',
    'accounts/acct_fixture',
  ]) {
    assert.equal(allowedOnboardingRequest(`https://api.stripe.com/v1/${path}`, 'POST'), false)
  }
  assert.equal(allowedOnboardingRequest('https://evil.example/v1/accounts', 'POST'), false)
  assert.equal(allowedOnboardingRequest('https://user@api.stripe.com/v1/accounts', 'POST'), false)
})
test('local browser requires exact host, origin, session and JSON body', () => {
  const headers = {
    host: '127.0.0.1:5193',
    origin: browserOrigin,
    cookie: 'kma_creator_local=fixture',
    'content-type': 'application/json',
  }
  assert.equal(localBrowserRequestAllowed(headers, 'fixture'), true)
  for (const bad of [
    { ...headers, host: 'evil.test' },
    { ...headers, origin: 'https://evil.test' },
    { ...headers, cookie: 'kma_creator_local=other' },
    { ...headers, 'content-type': 'text/plain' },
  ]) {
    assert.equal(Boolean(localBrowserRequestAllowed(bad, 'fixture')), false)
  }
})

export type AuthScreen = 'sign-in' | 'sign-up' | 'recover' | 'reset' | 'invite'
export type AuthField = 'fullName' | 'email' | 'password' | 'confirmation' | 'terms'
export type AuthErrors = Partial<Record<AuthField, string>>

export type InviteCallback = {
  tokenHash: string
}

export type SignupCallback = {
  tokenHash: string
}

export function authScreenFromHash(hash: string): AuthScreen | null {
  const [prefix, screen] = hash.replace(/^#/, '').split('/')
  if (prefix !== 'auth') return null
  return screen === 'sign-up' || screen === 'recover' || screen === 'reset' || screen === 'invite'
    ? screen
    : 'sign-in'
}

export function inviteCallbackFromSearch(search: string): InviteCallback | null {
  const params = new URLSearchParams(search)
  if (params.get('auth_action') !== 'invite' || params.get('type') !== 'invite') return null

  const tokenHash = params.get('token_hash')?.trim()
  if (!tokenHash || tokenHash.length > 512) return null
  return { tokenHash }
}

export function inviteCallbackClearedUrl(location: Pick<Location, 'pathname' | 'search'>) {
  const params = new URLSearchParams(location.search)
  params.delete('auth_action')
  params.delete('token_hash')
  params.delete('type')
  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}#auth/invite`
}

export function signupCallbackFromSearch(search: string): SignupCallback | null {
  const params = new URLSearchParams(search)
  if (params.get('auth_action') !== 'signup' || params.get('type') !== 'email') return null

  const tokenHash = params.get('token_hash')?.trim()
  if (!tokenHash || tokenHash.length > 512) return null
  return { tokenHash }
}

export function signupCallbackClearedUrl(
  location: Pick<Location, 'pathname' | 'search'>,
  destination: 'performance' | 'sign-up',
) {
  const params = new URLSearchParams(location.search)
  params.delete('auth_action')
  params.delete('token_hash')
  params.delete('type')
  const search = params.toString()
  return `${location.pathname}${search ? `?${search}` : ''}#${
    destination === 'performance' ? 'performance' : 'auth/sign-up'
  }`
}

export function validateEmail(value: string): string | undefined {
  if (!value.trim()) return 'Enter your email address.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    return 'Enter a complete email address, such as partner@example.com.'
  }
}

export function validateSignIn(email: string, password: string): AuthErrors {
  const errors: AuthErrors = {}
  const emailError = validateEmail(email)
  if (emailError) errors.email = emailError
  if (!password) errors.password = 'Enter your password.'
  return errors
}

export function validateSignUp({
  fullName,
  email,
  password,
  confirmation,
  acceptedTerms,
}: {
  fullName: string
  email: string
  password: string
  confirmation: string
  acceptedTerms: boolean
}): AuthErrors {
  const errors = validateReset(password, confirmation)
  const normalizedName = fullName.trim()
  if (!normalizedName) errors.fullName = 'Enter your full name.'
  else if (normalizedName.length > 120) errors.fullName = 'Use 120 characters or fewer.'
  const emailError = validateEmail(email)
  if (emailError) errors.email = emailError
  if (!acceptedTerms) {
    errors.terms = 'Confirm that you are at least 18 and agree to the Terms and Privacy Policy.'
  }
  return errors
}

export function validateReset(password: string, confirmation: string): AuthErrors {
  const errors: AuthErrors = {}
  if (password.length < 12) {
    errors.password = 'Use at least 12 characters for your new password.'
  }
  if (!confirmation) errors.confirmation = 'Confirm your new password.'
  else if (password !== confirmation) errors.confirmation = 'The two passwords do not match.'
  return errors
}

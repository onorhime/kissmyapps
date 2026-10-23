/**
 * Turns a failed action into a notice people can act on: a short title that
 * names what happened, the server's specific message, and what to do next.
 */
export type FeedbackError = Readonly<{
  code: string
  message?: string | null
  retryable?: boolean
}>

export type ErrorGuidance = Readonly<{ title: string; hint: string }>

const guidance: Record<string, ErrorGuidance> = {
  not_authenticated: {
    title: 'Your session ended',
    hint: 'Sign in again to continue. Nothing was changed.',
  },
  not_authorized: {
    title: 'Not allowed for your role',
    hint: 'Ask an Owner if you need access to this action.',
  },
  conflict: {
    title: 'This changed in the meantime',
    hint: 'Someone else may have updated it. Refresh, then try again.',
  },
  invalid_input: {
    title: 'Check the details',
    hint: 'Fix the highlighted fields and submit again.',
  },
  invalid_reference: {
    title: 'No longer available',
    hint: 'Refresh to load the latest records.',
  },
  invalid_state: {
    title: 'Not available right now',
    hint: 'Something this depends on has changed. Refresh to see the current state.',
  },
  temporarily_unavailable: {
    title: 'Connection problem',
    hint: 'Nothing was changed. Check your connection and try again.',
  },
  contract_unavailable: {
    title: 'Not set up yet',
    hint: 'This feature is not enabled in this environment yet.',
  },
  not_configured: {
    title: 'Not set up yet',
    hint: 'This feature is not enabled in this environment yet.',
  },
  invalid_response: {
    title: 'Unexpected response',
    hint: 'Try again. If it keeps happening, tell the platform team.',
  },
}

const fallback: ErrorGuidance = {
  title: 'That did not work',
  hint: 'Try again. If it keeps happening, tell the platform team.',
}

export function errorGuidance(error: FeedbackError | null | undefined): ErrorGuidance {
  if (!error) return fallback
  return guidance[error.code] ?? fallback
}

import { supabase } from '../../../lib/supabase'
import { createConnectGateway } from '../../creator-settlements/connect'
import type {
  ConnectBinding,
  ConnectClient,
  ConnectGateway,
  ConnectStatus,
} from '../../creator-settlements/connect'

/**
 * The creator's payout account for programs. The account, the sign-in checks and the reading
 * of the answers are the ones the older payout account already has
 * (`creator-settlements/connect.ts`), used as they are. This file only points them at the
 * program function and picks the words the page shows.
 */

/** The edge function that answers for program payout accounts, in the shapes of `creator-connect`. */
export const PAYOUT_ACCOUNT_FUNCTION = 'program-payout-account'

const NOT_AVAILABLE = { data: { enabled: false, bindings: [] }, error: null }

/** True for the function's own "payouts are switched off" answer, and for nothing else. */
async function switchedOff(error: { context?: unknown } | null): Promise<boolean> {
  const response = error?.context
  if (!(response instanceof Response) || response.status !== 503) return false
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    body.error === 'program_payouts_disabled'
  )
}

/**
 * The older gateway, talking to the program function. That gateway names its function itself,
 * so it is handed a client whose `invoke` sends every call to the program function instead.
 * Everything else (who is signed in, the fresh sign-in, the second factor, refusing an answer
 * for another account) is that gateway's own code.
 */
export function createPayoutAccountGateway(client?: ConnectClient | null): ConnectGateway {
  const source = client === undefined ? (supabase as ConnectClient | null) : client
  if (!source?.functions) return createConnectGateway(null)
  return createConnectGateway({
    auth: source.auth,
    functions: {
      async invoke(_name, options) {
        const response = await source.functions!.invoke(PAYOUT_ACCOUNT_FUNCTION, options)
        return (await switchedOff(response.error)) ? NOT_AVAILABLE : response
      },
    },
  })
}

/**
 * The creator's account on the platform that holds program money. The function sends that one
 * account only; anything else in the answer is left alone, so an account of another platform,
 * or one that is not for real money, is never shown here.
 */
export function payoutAccountOf(
  status: ConnectStatus,
  platformAccountId: string,
): ConnectBinding | null {
  if (!status.enabled) return null
  return (
    status.bindings.find(
      (binding) => binding.livemode && binding.platform_account_id === platformAccountId,
    ) ?? null
  )
}

/** Where a payout account stands, as the page tells it apart. */
export type PayoutAccountStanding = 'none' | 'needs_details' | 'checking' | 'paused' | 'ready'

export function payoutAccountStanding(account: ConnectBinding): PayoutAccountStanding {
  if (account.status === 'ready') return 'ready'
  if (account.status === 'not_connected' || !account.connected_account_id) return 'none'
  if (account.status === 'needs_information') return 'needs_details'
  // Nothing left to send in, and Stripe still holds the account back.
  return account.disabled_reason ? 'paused' : 'checking'
}

export interface PayoutAccountWords {
  /** Two or three words beside the mark. */
  label: string
  detail: string
  /** The button that opens the setup. */
  action: string
  /** True when the creator is the one who has to act. */
  asks: boolean
}

/** `waiting` is what a payout account is the only thing missing for, as "$44.10". */
export function payoutAccountWords(
  standing: PayoutAccountStanding,
  waiting: string | null = null,
): PayoutAccountWords {
  switch (standing) {
    case 'none':
      return {
        label: 'Not set up yet',
        detail: waiting
          ? `${waiting} can be paid once your account is set up.`
          : 'Add your bank details to be paid.',
        action: 'Set up payouts',
        asks: true,
      }
    case 'needs_details':
      return {
        label: 'Needs more details',
        detail: 'Stripe needs more details before you can be paid.',
        action: 'Continue setup',
        asks: true,
      }
    case 'paused':
      return {
        label: 'Paused',
        detail: 'Stripe has paused this account. Review your details to see why.',
        action: 'Review details',
        asks: true,
      }
    case 'checking':
      return {
        label: 'Being checked',
        detail: 'Stripe is checking your details. There is nothing to do right now.',
        action: 'Review details',
        asks: false,
      }
    case 'ready':
      return {
        label: 'Ready',
        detail: 'Payouts go to the bank account you added.',
        action: 'Review details',
        asks: false,
      }
  }
}

/** A refusal this page words itself, shown as it is. */
export class PayoutSetupRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayoutSetupRefused'
  }
}

/**
 * The sentence for a step that failed. The older gateway's sentences about signing in are
 * written for the creator and are passed on; its other sentences point to an administrator or
 * name the answer's parts, so those become `fallback`.
 */
export function payoutSetupMessage(error: unknown, fallback: string): string {
  if (error instanceof PayoutSetupRefused) return error.message
  const message = error instanceof Error ? error.message : ''
  return /sign.in|\bcode\b|verification method|^Your \w+( \w+)? could not be verified/i.test(
    message,
  )
    ? message
    : fallback
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

/** "Portugal" for "PT"; the code itself when the browser has no name for it. */
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** The countries an account can be opened in, by name. */
export function countryChoices(account: ConnectBinding): { code: string; name: string }[] {
  return account.allowed_countries
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

// Hosted Auth uses eight digits. Accept the full six-digit codes issued by older
// local environments too; Supabase still decides whether a code is authentic.
export function isMerchantEmailCode(value: string): boolean {
  return /^(?:[0-9]{6}|[0-9]{8})$/.test(value)
}

// Email clients may add whitespace while copying a code. Never strip other
// characters or truncate the value: that could turn a malformed code into one
// we accidentally submit. Keep this a string so leading zeroes survive.
export function normalizeMerchantEmailCode(value: string): string {
  return value.replace(/\s/g, '')
}

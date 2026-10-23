// Stripe API amounts use provider minor units, which differ from Intl for ISK and UGX.
const zeroDecimal = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])
export function providerCurrencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw Error('Use a three-letter currency code.')
  if (currency === 'ISK' || currency === 'UGX') return 2
  if (zeroDecimal.has(currency)) return 0
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}
export function providerMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw Error('Invalid amount.')
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    minor / 10 ** providerCurrencyDigits(currency),
  )
}
export function parseProviderMoney(value: string, currency: string, allowZero = false): number {
  const digits = providerCurrencyDigits(currency)
  const normalized = value.trim()
  const pattern = digits ? new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`) : /^\d+$/
  if (!pattern.test(normalized)) throw Error('Enter a valid amount for this currency.')
  const [whole, fraction = ''] = normalized.split('.')
  const result = Number(whole + fraction.padEnd(digits, '0'))
  if (!Number.isSafeInteger(result) || result < 0 || (!allowZero && result === 0))
    throw Error('Enter a valid amount within the supported range.')
  if ((currency === 'ISK' || currency === 'UGX') && result % 100 !== 0)
    throw Error('This currency requires whole amounts.')
  return result
}

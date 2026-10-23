// Non-USD amounts retain exact provider minor units until an explicit provider
// currency-exponent contract is supplied; never assume all currencies use cents.
export const checkoutListPrice = (amount: number | null, currency: string) =>
  amount === null
    ? null
    : currency === 'USD'
      ? `USD ${(amount / 100).toFixed(2)}`
      : `${currency} ${amount.toLocaleString('en-US')} minor units`

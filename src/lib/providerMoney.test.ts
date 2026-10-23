import { describe, it, expect } from 'vitest'
import { parseProviderMoney, providerMoney } from './providerMoney'
describe('provider currency units', () => {
  it.each([
    ['USD', '12.34', 1234],
    ['JPY', '1234', 1234],
    ['KWD', '1.234', 1234],
    ['MGA', '12', 12],
    ['ISK', '12', 1200],
    ['UGX', '1200', 120000],
  ] as const)('parses %s without a floating point round-trip', (currency, value, expected) =>
    expect(parseProviderMoney(value, currency)).toBe(expected),
  )
  it('uses Stripe units for ISK/UGX but rejects fractional units on input', () => {
    expect(providerMoney(1200, 'ISK')).toContain('12')
    expect(providerMoney(120000, 'UGX')).toContain('1,200')
    expect(() => parseProviderMoney('1.23', 'ISK')).toThrow(/whole/)
    expect(() => parseProviderMoney('1.23', 'UGX')).toThrow(/whole/)
    expect(() => parseProviderMoney('12.3', 'JPY')).toThrow()
    expect(parseProviderMoney('0', 'JPY', true)).toBe(0)
    expect(() => parseProviderMoney('9007199254740993', 'USD')).toThrow()
  })
})

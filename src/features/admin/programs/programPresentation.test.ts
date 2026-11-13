import { describe, expect, it } from 'vitest'
import { mapAdminProgramReview } from '../api/programs'
import { programRow } from './fixtures'
import {
  categoryLabel,
  commissionHeadline,
  commissionLine,
  countryName,
  landingLink,
  monogram,
  programMoney,
  programPercent,
  programStatus,
  relativeTime,
} from './programPresentation'

const program = (overrides: Record<string, unknown> = {}) =>
  mapAdminProgramReview(programRow(overrides))

describe('program presentation', () => {
  it('shows money and percentages in normal units', () => {
    expect(programMoney(2000, 'USD')).toBe('$20.00')
    expect(programMoney(1234567, 'USD')).toBe('$12,345.67')
    expect(programMoney(5, 'USD')).toBe('$0.05')
    expect(programMoney(2000, 'EUR')).toBe('20.00 EUR')
    expect(programPercent(3000)).toBe('30%')
    expect(programPercent(1250)).toBe('12.5%')
    expect(programPercent(1)).toBe('0.01%')
    expect(programPercent(10000)).toBe('100%')
  })

  it.each([
    [{ commission_duration: 'first_payment', commission_months: null }, '30% of the first payment'],
    [{}, '30% of every payment for 12 months'],
    [{ commission_months: 1 }, '30% of every payment for 1 month'],
    [{ commission_duration: 'lifetime', commission_months: null }, '30% of every payment'],
  ])('words a percentage commission %#', (overrides, headline) => {
    expect(commissionHeadline(program(overrides))).toBe(headline)
  })

  it.each([
    [
      { commission_duration: 'first_payment', commission_months: null },
      '$20.00 on the first payment',
    ],
    [{}, '$20.00 on every payment for 12 months'],
    [{ commission_duration: 'lifetime', commission_months: null }, '$20.00 on every payment'],
    [
      { commission_duration: 'lifetime', commission_months: null, currency: 'EUR' },
      '20.00 EUR on every payment',
    ],
  ])('words a fixed commission %#', (overrides, headline) => {
    expect(
      commissionHeadline(
        program({
          commission_type: 'fixed',
          commission_rate_bps: null,
          commission_fixed_minor: 2000,
          ...overrides,
        }),
      ),
    ).toBe(headline)
  })

  it('never shows basis points or minor units', () => {
    const line = commissionLine(program())
    expect(line).not.toMatch(/3000|bps|minor/)
  })

  it('falls back to the agreement when the commission fields are incomplete', () => {
    expect(commissionLine(program({ commission_type: null }))).toBe(
      '30% of every payment for 12 months',
    )
    expect(commissionLine(program({ commission_type: null, agreement: null }))).toBeNull()
    expect(
      commissionHeadline(program({ commission_duration: 'months', commission_months: null })),
    ).toBeNull()
  })

  it('links only to https landing pages', () => {
    expect(landingLink('https://speaksix.com/start')).toEqual({
      href: 'https://speaksix.com/start',
      label: 'speaksix.com/start',
    })
    expect(landingLink('https://ledgerly.app/')?.label).toBe('ledgerly.app')
    expect(landingLink('https://a.example/p?plan=annual')?.label).toBe('a.example/p?plan=annual')
    expect(landingLink('http://speaksix.com')).toBeNull()
    expect(landingLink('javascript:alert(1)')).toBeNull()
    expect(landingLink('https://user:secret@speaksix.com')).toBeNull()
    expect(landingLink('not a url')).toBeNull()
    expect(landingLink(null)).toBeNull()
  })

  it('names categories, countries and statuses in plain words', () => {
    expect(categoryLabel('health_fitness')).toBe('Health and fitness')
    expect(categoryLabel('new_kind')).toBe('New kind')
    expect(categoryLabel(null)).toBeNull()
    expect(countryName('GB')).toBe('United Kingdom')
    expect(countryName('Great Britain')).toBe('Great Britain')
    expect(countryName(null)).toBeNull()
    expect(programStatus({ status: 'live', pauseReason: null }).label).toBe('Live')
    expect(programStatus({ status: 'paused', pauseReason: 'admin' }).label).toBe(
      'Paused by KissMyApps',
    )
    expect(programStatus({ status: 'paused', pauseReason: 'merchant' }).label).toBe(
      'Paused by merchant',
    )
    expect(programStatus({ status: 'paused', pauseReason: 'stripe_disconnected' }).label).toBe(
      'Paused, Stripe disconnected',
    )
    expect(programStatus({ status: 'changes_requested', pauseReason: null }).label).toBe(
      'Changes requested',
    )
    expect(monogram('  speakSix')).toBe('S')
    expect(monogram('')).toBe('P')
  })

  it('says how long a program has waited', () => {
    const now = Date.parse('2026-11-14T10:00:00Z')
    expect(relativeTime('2026-11-14T09:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-11-14T09:55:00Z', now)).toBe('5 minutes ago')
    expect(relativeTime('2026-11-14T08:00:00Z', now)).toBe('2 hours ago')
    expect(relativeTime('2026-11-13T09:00:00Z', now)).toBe('1 day ago')
    expect(relativeTime('2026-11-11T10:00:00Z', now)).toBe('3 days ago')
    expect(relativeTime('2026-10-01T10:00:00Z', now)).toBe('on 1 Oct 2026')
    expect(relativeTime('2026-11-14T11:00:00Z', now)).toBe('just now')
    expect(relativeTime('nonsense', now)).toBeNull()
    expect(relativeTime(null, now)).toBeNull()
  })
})

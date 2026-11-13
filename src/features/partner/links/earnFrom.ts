import type { EarnFrom } from '../../marketplace/model'

/**
 * What a program pays a creator for, and the words and columns that follow from it in the
 * partner dashboard. A program pays for sales (a commission), for events such as a sign-up (a
 * reward each), or for both. One from before events could be rewarded pays for sales.
 */

export type { EarnFrom }

const EARN_FROM: readonly EarnFrom[] = ['sales', 'events', 'both']

/** True for a key an answer from before events could be rewarded does not carry. */
export const absent = (value: unknown): value is null | undefined =>
  value === undefined || value === null

/** What the program pays for, as the answer says it. Null for a word these pages do not know. */
export function readEarnFrom(value: unknown): EarnFrom | null {
  return EARN_FROM.includes(value as EarnFrom) ? (value as EarnFrom) : null
}

/**
 * What a program pays for. An answer from before events could be rewarded does not say, and
 * that is a program that pays for sales.
 */
export function earnFromOf(program: { earn_from?: EarnFrom }): EarnFrom {
  return program.earn_from ?? 'sales'
}

/** What the program credits a creator for, as it reads in a sentence: "sales and events". */
export function creditedFor(earnFrom: EarnFrom = 'sales'): string {
  if (earnFrom === 'events') return 'events'
  return earnFrom === 'both' ? 'sales and events' : 'sales'
}

/** The same words at the start of a sentence or a title: "Sales and events". */
export function creditedTitle(earnFrom: EarnFrom = 'sales'): string {
  const words = creditedFor(earnFrom)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A number shown between clicks and earnings. */
export type CountKind = 'events' | 'sales'

export const COUNT_LABELS: Record<CountKind, string> = { events: 'Events', sales: 'Sales' }

/**
 * The counts between Clicks and Earnings, in the order they are read: sales for a program that
 * pays for sales, events for one that pays for events, and events then sales for one that pays
 * for both, so that Conversion still follows Sales.
 */
export function countKinds(earnFrom: EarnFrom): CountKind[] {
  if (earnFrom === 'events') return ['events']
  return earnFrom === 'both' ? ['events', 'sales'] : ['sales']
}

/**
 * What a click is counted as turning into, for the conversion rate: a sale, or an event in a
 * program that pays for events only.
 */
export function conversionOf(earnFrom: EarnFrom): CountKind {
  return earnFrom === 'events' ? 'events' : 'sales'
}

/** One of a row's counts. Events an older answer does not carry are none. */
export function countOf(row: { sales: number; events?: number }, kind: CountKind): number {
  return kind === 'events' ? (row.events ?? 0) : row.sales
}

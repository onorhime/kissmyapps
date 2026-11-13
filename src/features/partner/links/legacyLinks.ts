import { useEffect, useState } from 'react'
import type { PartnerProduct } from '../api'
import type { PartnerLiveWorkspaceSnapshot } from '../live/types'

/**
 * Whether the Links page still shows the older product links under the program links.
 *
 * A program's own product is in the creator's product list too, because their program links
 * point at it. It has no agreement of its own (its terms are the program's), and the product
 * list gives it no main link, because that list only hands out a link under an agreement. So a
 * product from before programs is one with its own agreement, a tracking-only demo, or one the
 * list gives a main link for.
 */
export function isLegacyProduct(
  product: Pick<
    PartnerProduct,
    'agreementStatus' | 'trackingMode' | 'mainTrackingUrl' | 'testMainTrackingUrl'
  >,
): boolean {
  return (
    product.agreementStatus !== null ||
    product.trackingMode === 'tracking_only' ||
    Boolean(product.mainTrackingUrl) ||
    Boolean(product.testMainTrackingUrl)
  )
}

/**
 * True when the creator has an older product, false when they have none, null while the
 * products are still being read. A read that failed counts as true: the older page is where
 * that failure is said and can be tried again.
 */
export function legacyLinksKnown(
  snapshot: Pick<PartnerLiveWorkspaceSnapshot, 'status' | 'resources'>,
): boolean | null {
  if (snapshot.status === 'loading') return null
  const products = snapshot.resources.products
  if (products.status !== 'ready' && products.status !== 'empty') return true
  return products.data.some(isLegacyProduct)
}

/**
 * The answer for the page, and for whoever names the page in the navigation. While products
 * are read again (another product was picked, a refresh) the last answer stands, so the older
 * links do not leave the page and come back.
 */
export function useLegacyLinks(
  snapshot: Pick<PartnerLiveWorkspaceSnapshot, 'status' | 'resources'>,
  onChange?: (shown: boolean) => void,
): boolean {
  const known = legacyLinksKnown(snapshot)
  const [last, setLast] = useState(false)
  if (known !== null && known !== last) setLast(known)
  const shown = known ?? last

  useEffect(() => {
    onChange?.(shown)
  }, [onChange, shown])

  return shown
}

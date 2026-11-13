import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { discountPercent } from '../../marketplace/model'
import { promoCodeLine, promoCodeNote } from './promoCode'
import type { PromoCodeShown } from './promoCode'

/**
 * A creator's promo code, wherever it is shown: the Links page and a program's page. A ready
 * code is printed with a Copy button; one being made or that could not be made is said in a
 * line, without its letters, so nobody hands out a code that does not work yet.
 */
export function PromoCodeBody({
  promo,
  brand = null,
  appliedByLink = false,
  compact = false,
}: {
  promo: PromoCodeShown
  /** Who has been told when the code could not be made. */
  brand?: string | null
  /** The program's link opens a checkout that applies the code by itself. */
  appliedByLink?: boolean
  /** Leaves out the quieter line under the code, where the space is a card's. */
  compact?: boolean
}) {
  const note = compact ? null : promoCodeNote(promo, appliedByLink)
  return (
    <div className="p8-promo-body">
      {promo.status === 'active' ? (
        <CodeRow code={promo.code} off={promo.discount_bps} />
      ) : (
        <p className={`p8-promo-state p8-promo-${promo.status}`}>{promoCodeLine(promo, brand)}</p>
      )}
      {note && <p className="p8-promo-note">{note}</p>}
    </div>
  )
}

/** "Your code ANNA10 gives buyers 10% off", the code itself selectable at one click. */
function CodeRow({ code, off }: { code: string; off: number }) {
  const field = useRef<HTMLSpanElement>(null)
  const [copied, setCopied] = useState<'no' | 'yes' | 'manual'>('no')

  useEffect(() => {
    if (copied === 'no') return
    const timeout = setTimeout(() => setCopied('no'), 4000)
    return () => clearTimeout(timeout)
  }, [copied])

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(code)
      setCopied('yes')
    } catch {
      if (field.current) window.getSelection()?.selectAllChildren(field.current)
      setCopied('manual')
    }
  }

  return (
    <>
      <div className="p8-promo-row">
        <p className="p8-promo-line">
          Your code{' '}
          <span className="p8-code" ref={field}>
            {code}
          </span>{' '}
          gives buyers {`${discountPercent(off)}\u00a0off`}
        </p>
        <button type="button" className="mkt-btn mkt-btn-quiet" onClick={() => void copy()}>
          {copied === 'yes' ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          {copied === 'yes' ? 'Copied' : 'Copy code'}
        </button>
      </div>
      <p className="p8-promo-by-hand" role="status">
        {copied === 'manual' && 'The code is selected. Copy it with your keyboard.'}
        {copied === 'yes' && <span className="mkt-sr">{code} copied</span>}
      </p>
    </>
  )
}

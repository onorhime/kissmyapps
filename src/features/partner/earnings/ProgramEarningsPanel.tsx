import { useState } from 'react'
import { formatMoney } from '../../../merchant/programs'
import { marketplaceHash } from '../../marketplace/routing'
import type { PartnerDataGateway } from '../api'
import {
  commissionAmount,
  commissionStatusLine,
  earningsErrorMessage,
  hasEarnings,
  salesCount,
  shortDay,
} from './earnings'
import type { ProgramEarnings, ProgramEarningsRow, RecentCommission } from './earnings'
import { useProgramEarnings } from './useProgramEarnings'
import './ProgramEarnings.css'

/**
 * What a creator has earned through the programs they joined: per program, the commission
 * still inside its hold and the commission that has passed it, then the latest commissions.
 * It only shows money. Paying approved earnings out is not part of this panel.
 */

/** Rows shown before "Show all". */
const RECENT_SHOWN = 8

export function ProgramEarningsPanel({ gateway }: { gateway: PartnerDataGateway }) {
  const { state, retry } = useProgramEarnings(gateway)
  if (state.status === 'hidden') return null

  return (
    <section
      className="panel pe-panel"
      aria-labelledby="pe-title"
      aria-busy={state.status === 'loading'}
    >
      <header className="pe-head">
        <h2 id="pe-title">Program earnings</h2>
        <p>
          Commission from the programs you joined in the Marketplace. It is pending while the
          program’s hold runs, then approved unless the sale was refunded.
        </p>
      </header>

      {state.status === 'loading' && <EarningsSkeleton />}

      {state.status === 'error' && (
        <div className="pe-state" role="alert">
          <h3>Program earnings did not load</h3>
          <p>{earningsErrorMessage(state.error)}</p>
          {state.error?.code !== 'not_authenticated' && (
            <button type="button" className="pe-btn" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' &&
        (hasEarnings(state.earnings) ? (
          <Earnings earnings={state.earnings} />
        ) : (
          <div className="pe-state">
            <h3>Nothing earned yet</h3>
            <p>When someone buys through one of your program links, your commission shows here.</p>
            <a className="pe-btn" href={marketplaceHash()}>
              Open the marketplace
            </a>
          </div>
        ))}
    </section>
  )
}

function EarningsSkeleton() {
  return (
    <div className="pe-skeleton">
      <p className="pe-sr" role="status">
        Loading your program earnings
      </p>
      <div className="pe-program" aria-hidden="true">
        <span className="pe-bar" style={{ width: 140, height: 18 }} />
        <span className="pe-bar" style={{ width: 96, height: 26 }} />
        <span className="pe-bar" style={{ width: 96, height: 26 }} />
      </div>
      <span className="pe-bar" style={{ width: '100%', height: 44 }} aria-hidden="true" />
      <span className="pe-bar" style={{ width: '100%', height: 44 }} aria-hidden="true" />
    </div>
  )
}

function Earnings({ earnings }: { earnings: ProgramEarnings }) {
  const [showAll, setShowAll] = useState(false)
  const now = new Date()
  const programs = earnings.programs.filter(
    (row) =>
      row.pending_minor !== 0 || row.approved_minor !== 0 || row.paid_minor !== 0 || row.sales > 0,
  )
  const recent = showAll ? earnings.recent : earnings.recent.slice(0, RECENT_SHOWN)

  return (
    <>
      {programs.length > 0 && (
        <ul className="pe-programs" aria-label="Earnings by program">
          {programs.map((row) => (
            <ProgramRow key={row.program_id} row={row} now={now} />
          ))}
        </ul>
      )}

      {earnings.recent.length > 0 && (
        <div className="pe-recent">
          <h3 id="pe-recent-title">Recent commissions</h3>
          <table aria-labelledby="pe-recent-title">
            <thead>
              <tr>
                <th scope="col">Sale date</th>
                <th scope="col">Program</th>
                <th scope="col" className="pe-num">
                  Sale
                </th>
                <th scope="col" className="pe-num">
                  Your commission
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((commission) => (
                <CommissionRow key={commission.id} commission={commission} now={now} />
              ))}
            </tbody>
          </table>
          {earnings.recent.length > RECENT_SHOWN && !showAll && (
            <button type="button" className="pe-btn" onClick={() => setShowAll(true)}>
              Show all {earnings.recent.length}
            </button>
          )}
        </div>
      )}

      <p className="pe-note">
        Payouts of approved earnings are coming. Approved money has already been collected from the
        brand.
      </p>
    </>
  )
}

function ProgramRow({ row, now }: { row: ProgramEarningsRow; now: Date }) {
  const holdEnds =
    row.pending_minor > 0 && row.next_release_at && Date.parse(row.next_release_at) > now.getTime()
      ? shortDay(row.next_release_at, now)
      : null
  return (
    <li className="pe-program">
      <div className="pe-program-name">
        {row.slug ? <a href={marketplaceHash(row.slug)}>{row.name}</a> : <span>{row.name}</span>}
        <small>{salesCount(row.sales)}</small>
      </div>
      <dl>
        <div>
          <dt>Pending</dt>
          <dd>{formatMoney(row.pending_minor, row.currency)}</dd>
          {holdEnds && <dd className="pe-sub">First hold ends {holdEnds}</dd>}
        </div>
        <div>
          <dt>Approved</dt>
          <dd>{formatMoney(row.approved_minor, row.currency)}</dd>
        </div>
        {row.paid_minor > 0 && (
          <div>
            <dt>Paid out</dt>
            <dd>{formatMoney(row.paid_minor, row.currency)}</dd>
          </div>
        )}
      </dl>
    </li>
  )
}

function CommissionRow({ commission, now }: { commission: RecentCommission; now: Date }) {
  const { amount, was } = commissionAmount(commission)
  return (
    <tr className={commission.status === 'reversed' ? 'pe-returned' : undefined}>
      <td>{commission.paid_at ? shortDay(commission.paid_at, now) : '—'}</td>
      <th scope="row">{commission.program_name}</th>
      <td className="pe-num">
        {commission.sale_amount_minor === null
          ? '—'
          : formatMoney(commission.sale_amount_minor, commission.currency)}
      </td>
      <td className="pe-num">
        <span className="pe-amount">{amount}</span>
        {was && <small>{was} before a refund</small>}
      </td>
      <td>
        <span className={`pe-status pe-status-${commission.status}`}>
          {commissionStatusLine(commission, now)}
        </span>
      </td>
    </tr>
  )
}

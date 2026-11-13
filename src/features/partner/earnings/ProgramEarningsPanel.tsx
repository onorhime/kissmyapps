import { useState } from 'react'
import { formatMoney } from '../../../merchant/programs'
import { marketplaceHash } from '../../marketplace/routing'
import type { ConnectClient, ConnectGateway } from '../../creator-settlements/connect'
import type { PartnerDataGateway } from '../api'
import {
  commissionAmount,
  commissionStatusLine,
  earningsErrorMessage,
  hasEarnings,
  hasRewards,
  payableNow,
  payoutRuleLine,
  payoutStatusLine,
  payoutTone,
  payoutsOn,
  programActivity,
  programHasEarnings,
  rewardLine,
  shortDay,
} from './earnings'
import type {
  ProgramEarnings,
  ProgramEarningsRow,
  ProgramPayout,
  RecentCommission,
} from './earnings'
import { PayoutAccountCard } from './PayoutAccountCard'
import { useProgramEarnings } from './useProgramEarnings'
import './ProgramEarnings.css'

/**
 * What a creator has earned through the programs they joined: per program, the commission
 * still inside its hold, the commission that has passed it, what is in a payout on its way and
 * what was paid; then the payouts and the latest commissions. A program can also pay a reward
 * for an event, such as a sign-up: a reward is listed with the sales, under its own name.
 *
 * While payouts are switched on it also holds the creator's payout account. While they are
 * off, or on a database from before payouts, it shows money only: no payout account, no
 * payouts, and nothing about when a payout happens.
 */

/** Rows shown before "Show all". */
const RECENT_SHOWN = 8
const PAYOUTS_SHOWN = 5

export function ProgramEarningsPanel({
  gateway,
  client,
  accountGateway,
}: {
  gateway: PartnerDataGateway
  /** The connection the payout account is set up through. Left out: the app's own. */
  client?: ConnectClient | null
  /** Test and composition seam for the payout account. */
  accountGateway?: ConnectGateway
}) {
  const { state, retry } = useProgramEarnings(gateway)
  if (state.status === 'hidden') return null
  const terms = state.status === 'ready' ? payoutsOn(state.earnings) : null
  const rewards = state.status === 'ready' && state.earnings ? hasRewards(state.earnings) : false

  return (
    <section
      className={terms ? 'panel pe-panel pe-paying' : 'panel pe-panel'}
      aria-labelledby="pe-title"
      aria-busy={state.status === 'loading'}
    >
      <header className="pe-head">
        <h2 id="pe-title">Program earnings</h2>
        <p>
          {rewards
            ? 'Commission and rewards from the programs you joined in the Marketplace. Each is pending while the program’s hold runs, then approved unless it was refunded or rejected.'
            : 'Commission from the programs you joined in the Marketplace. It is pending while the program’s hold runs, then approved unless the sale was refunded.'}
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

      {terms && (
        <PayoutAccountCard
          platformAccountId={terms.platform_account_id}
          waiting={payableNow(terms)}
          client={client}
          gateway={accountGateway}
        />
      )}

      {state.status === 'ready' &&
        (hasEarnings(state.earnings) ? (
          <Earnings earnings={state.earnings} />
        ) : (
          <div className="pe-state">
            <h3>Nothing earned yet</h3>
            <p>
              When someone buys or signs up through one of your program links, what you earn shows
              here.
            </p>
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
  const paying = payoutsOn(earnings) !== null
  const rule = payoutRuleLine(earnings)
  const programs = earnings.programs.filter(programHasEarnings)
  const recent = showAll ? earnings.recent : earnings.recent.slice(0, RECENT_SHOWN)
  // With a reward in the list its words are about earnings; with rewards only, no row has a
  // sale amount, so that column is left out.
  const withRewards = earnings.recent.some((commission) => commission.kind === 'reward')
  const withSales = earnings.recent.some((commission) => commission.kind !== 'reward')
  // Payouts were never made here: the line from before payouts still holds.
  const payoutsToCome =
    !paying &&
    (earnings.payouts?.length ?? 0) === 0 &&
    earnings.programs.every((row) => row.paying_minor === 0 && row.paid_minor === 0)

  return (
    <>
      {programs.length > 0 && (
        <ul className="pe-programs" aria-label="Earnings by program">
          {programs.map((row) => (
            <ProgramRow key={row.program_id} row={row} now={now} paying={paying} />
          ))}
        </ul>
      )}

      {rule && <p className="pe-note">{rule}</p>}

      {paying && <Payouts payouts={earnings.payouts ?? []} now={now} />}

      {earnings.recent.length > 0 && (
        <div className={withSales ? 'pe-list pe-recent' : 'pe-list pe-recent pe-recent-rewards'}>
          <h3 id="pe-recent-title">{withRewards ? 'Recent earnings' : 'Recent commissions'}</h3>
          <table aria-labelledby="pe-recent-title">
            <thead>
              <tr>
                <th scope="col">{withRewards ? 'Date' : 'Sale date'}</th>
                <th scope="col">Program</th>
                {withSales && (
                  <th scope="col" className="pe-num">
                    Sale
                  </th>
                )}
                <th scope="col" className="pe-num">
                  {withRewards ? 'You earn' : 'Your commission'}
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((commission) => (
                <CommissionRow
                  key={commission.id}
                  commission={commission}
                  now={now}
                  saleColumn={withSales}
                />
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

      {payoutsToCome && (
        <p className="pe-note">
          Payouts of approved earnings are coming. Approved money has already been collected from
          the brand.
        </p>
      )}
    </>
  )
}

/**
 * One figure of a program. With four of them in a row, one that is nothing yet is printed in
 * grey, so the money that is there stands out.
 */
function Figure({
  label,
  minor,
  currency,
  quietZero,
  note,
}: {
  label: string
  minor: number
  currency: string
  quietZero: boolean
  note?: string | null
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={quietZero && minor === 0 ? 'pe-zero' : undefined}>
        {formatMoney(minor, currency)}
      </dd>
      {note && <dd className="pe-sub">{note}</dd>}
    </div>
  )
}

function ProgramRow({
  row,
  now,
  paying,
}: {
  row: ProgramEarningsRow
  now: Date
  /** Payouts are on: the payout figures are shown even while they are nothing. */
  paying: boolean
}) {
  const holdEnds =
    row.pending_minor > 0 && row.next_release_at && Date.parse(row.next_release_at) > now.getTime()
      ? shortDay(row.next_release_at, now)
      : null
  return (
    <li className="pe-program">
      <div className="pe-program-name">
        {row.slug ? <a href={marketplaceHash(row.slug)}>{row.name}</a> : <span>{row.name}</span>}
        <small>{programActivity(row)}</small>
      </div>
      <dl>
        <Figure
          label="Pending"
          minor={row.pending_minor}
          currency={row.currency}
          quietZero={paying}
          note={holdEnds && `First hold ends ${holdEnds}`}
        />
        <Figure
          label="Approved"
          minor={row.approved_minor}
          currency={row.currency}
          quietZero={paying}
        />
        {(paying || row.paying_minor !== 0) && (
          <Figure
            label="On its way"
            minor={row.paying_minor}
            currency={row.currency}
            quietZero={paying}
          />
        )}
        {(paying || row.paid_minor !== 0) && (
          <Figure label="Paid" minor={row.paid_minor} currency={row.currency} quietZero={paying} />
        )}
      </dl>
    </li>
  )
}

function Payouts({ payouts, now }: { payouts: ProgramPayout[]; now: Date }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? payouts : payouts.slice(0, PAYOUTS_SHOWN)
  return (
    <div className="pe-list pe-payouts">
      <h3 id="pe-payouts-title">Payouts</h3>
      {payouts.length === 0 ? (
        <p className="pe-empty">No payouts yet.</p>
      ) : (
        <table aria-labelledby="pe-payouts-title">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="pe-num">
                Amount
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((payout) => {
              const tone = payoutTone(payout.status)
              return (
                <tr key={payout.id} className={tone === 'returned' ? 'pe-returned' : undefined}>
                  <td>{payout.created_at ? shortDay(payout.created_at, now) : '—'}</td>
                  <td className="pe-num">
                    <span className="pe-amount">
                      {formatMoney(payout.amount_minor, payout.currency)}
                    </span>
                  </td>
                  <td>
                    <span className={`pe-status pe-status-${tone}`}>
                      {payoutStatusLine(payout, now)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {payouts.length > PAYOUTS_SHOWN && !showAll && (
        <button type="button" className="pe-btn" onClick={() => setShowAll(true)}>
          Show all {payouts.length} payouts
        </button>
      )}
    </div>
  )
}

function CommissionRow({
  commission,
  now,
  saleColumn,
}: {
  commission: RecentCommission
  now: Date
  /** False when the list holds rewards only, which have no sale amount. */
  saleColumn: boolean
}) {
  const { amount, was } = commissionAmount(commission)
  const reward = rewardLine(commission)
  const classes = [commission.status === 'reversed' && 'pe-returned', reward && 'pe-reward']
    .filter(Boolean)
    .join(' ')
  return (
    <tr className={classes || undefined}>
      <td>{commission.paid_at ? shortDay(commission.paid_at, now) : '—'}</td>
      <th scope="row">
        {commission.program_name}
        {reward && <small>{reward}</small>}
      </th>
      {saleColumn && (
        <td className="pe-num">
          {commission.sale_amount_minor === null
            ? '—'
            : formatMoney(commission.sale_amount_minor, commission.currency)}
        </td>
      )}
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

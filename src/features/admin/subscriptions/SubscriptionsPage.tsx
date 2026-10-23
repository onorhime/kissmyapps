import { useEffect, useState } from 'react'
import { Boxes, RefreshCw, Search } from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import { Select } from '../../../components/Select'
import type { AdminGateway, AdminProduct, AdminRole } from '../api'
import {
  SUBSCRIPTION_LABELS,
  SUBSCRIPTION_STATUSES,
  type AdminSubscription,
  type AdminSubscriptionPage,
  type SubscriptionFilters,
} from '../api/subscriptions'
import './SubscriptionsPage.css'
import { checkoutListPrice } from './presentation'

const PAGE_SIZE = 25
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value)) + ' UTC'
    : 'Not recorded'
function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? 'Not recorded'}</dd>
    </div>
  )
}
function SubscriptionDetail({ item }: { item: AdminSubscription }) {
  return (
    <>
      <p className="subscription-notice">
        Read-only billing evidence. Subscription status is not proof of paid revenue, commission
        eligibility or app access.
      </p>
      <h3>Subscription and billing</h3>
      <dl className="subscription-facts">
        <Fact label="Product" value={item.productName} />
        <Fact label="Status" value={SUBSCRIPTION_LABELS[item.status]} />
        <Fact label="Stripe subscription ID" value={item.stripeId} />
        <Fact label="Internal account ID" value={item.accountId} />
        <Fact label="Offer" value={item.offerName} />
        <Fact
          label="Checkout list price"
          value={checkoutListPrice(item.checkoutListAmountMinor, item.currency)}
        />
        <Fact label="Current period starts" value={date(item.periodStart)} />
        <Fact label="Current period ends" value={date(item.periodEnd)} />
        <Fact label="Cancellation timestamp" value={date(item.cancelledAt)} />
        <Fact label="Latest normalized Stripe event" value={date(item.evidenceAt)} />
        <Fact
          label="Initial checkout"
          value={
            item.zeroTotalCheckout
              ? 'Verified zero-total checkout'
              : 'No zero-total checkout evidence'
          }
        />
        <Fact label="Recorded paid invoices" value={item.recordedPaidInvoices} />
      </dl>
      <p className="subscription-caption">
        List price is the saved checkout price before discounts, not an amount collected or a
        prediction of the next charge. Paid invoice counts exclude zero-total invoices and do not
        subtract refunds. The period end is not a guaranteed charge date. Missing timestamps remain
        unknown.
      </p>
      <h3>Partner attribution</h3>
      <dl className="subscription-facts">
        <Fact label="Partner" value={item.partnerName} />
        <Fact label="Source" value={item.sourceName} />
        <Fact label="Campaign" value={item.campaignName} />
        <Fact label="Funnel" value={item.funnelName} />
        <Fact label="Placement (Sub 1)" value={item.sub1} />
        <Fact label="Position (Sub 2)" value={item.sub2} />
        <Fact label="Creative (Sub 3)" value={item.sub3} />
        <Fact label="Acquisition ID" value={item.acquisitionId} />
      </dl>
      <p className="subscription-caption">
        Attribution comes from the recorded acquisition and click, not a live guess from the
        browser. Buyer email and payment details are not exposed here.
      </p>
    </>
  )
}
export function SubscriptionsPage({
  gateway,
  products,
  role,
}: {
  gateway: AdminGateway
  products: readonly AdminProduct[]
  role: AdminRole
}) {
  const [filters, setFilters] = useState<SubscriptionFilters>({
    query: '',
    status: '',
    productId: '',
    sort: 'newest',
    offset: 0,
  })
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<AdminSubscriptionPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<AdminSubscription | null>(null)
  const [now, setNow] = useState(Date.now)
  const allowed = role !== 'support'
  useEffect(() => {
    if (!allowed) return
    let current = true
    async function load() {
      setLoading(true)
      try {
        const result = await gateway.getSubscriptions?.({ ...filters, limit: PAGE_SIZE })
        if (!current) return
        if (!result || result.status !== 'ready' || !result.data) {
          setData(null)
          setSelected(null)
          setError(
            result?.status === 'unauthorized'
              ? 'A password-authenticated Owner, Operations, Finance or Analyst session is required.'
              : 'Subscriptions could not be loaded. No empty or healthy state is assumed. Try refreshing.',
          )
        } else {
          setData(result.data)
          setSelected(null)
          setError(null)
        }
      } catch {
        if (current) {
          setData(null)
          setSelected(null)
          setError('Subscriptions could not be loaded. Try refreshing.')
        }
      } finally {
        if (current) {
          setLoading(false)
          setNow(Date.now())
        }
      }
    }
    void load()
    return () => {
      current = false
    }
  }, [gateway, filters, reload, allowed])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  function change(values: SubscriptionFilters) {
    setData(null)
    setSelected(null)
    setError(null)
    setFilters((previous) => ({ ...previous, offset: 0, ...values }))
  }
  if (!allowed)
    return (
      <section className="admin-state-card">
        <h1>Subscription access restricted</h1>
        <p>
          Owner, Operations, Finance and Analyst accounts can view this billing directory. Support
          access is not enabled.
        </p>
      </section>
    )
  const offset = filters.offset ?? 0
  const stale =
    data &&
    (now - Date.parse(data.generatedAt) > 180_000 || Date.parse(data.generatedAt) > now + 60_000)
  return (
    <section className="admin-subscriptions" aria-labelledby="subscriptions-title">
      <header className="subscription-heading">
        <div>
          <p className="admin-eyebrow">BILLING VISIBILITY</p>
          <h1 id="subscriptions-title">
            Subscriptions<span>.</span>
          </h1>
          <p>
            Recorded Stripe subscriptions, connected to the partners and products that brought them
            here.
          </p>
        </div>
        <button
          type="button"
          className="admin-secondary-button"
          disabled={loading}
          onClick={() => setReload((v) => v + 1)}
        >
          <RefreshCw size={17} aria-hidden="true" />
          {loading ? 'Loading subscriptions…' : 'Refresh subscriptions'}
        </button>
      </header>
      <p className="subscription-notice">
        Read-only · No cancellations, refunds or billing changes. Active and trial subscriptions can
        have no paid revenue.
      </p>
      <form
        className="subscription-filters"
        aria-label="Filter subscriptions"
        onSubmit={(e) => {
          e.preventDefault()
          change({ query: query.trim() })
        }}
      >
        <label className="subscription-search">
          Search subscriptions
          <input
            value={query}
            maxLength={120}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Partner, product, Stripe ID or account ID"
          />
        </label>
        <button type="submit" className="admin-secondary-button">
          <Search size={17} aria-hidden="true" />
          Search
        </button>
        <Select
          label="Product"
          value={filters.productId ?? ''}
          onChange={(productId) => change({ productId })}
          options={[
            { value: '', label: 'All products' },
            ...products.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <Select
          label="Status"
          value={filters.status ?? ''}
          onChange={(status) => change({ status: status as SubscriptionFilters['status'] })}
          options={[
            { value: '', label: 'All statuses' },
            ...SUBSCRIPTION_STATUSES.map((s) => ({ value: s, label: SUBSCRIPTION_LABELS[s] })),
          ]}
        />
        <Select
          label="Order"
          value={filters.sort ?? 'newest'}
          onChange={(sort) => change({ sort: sort as 'newest' | 'oldest' })}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
        />
        <button
          type="button"
          className="admin-text-button"
          onClick={() => {
            setQuery('')
            change({ query: '', status: '', productId: '', sort: 'newest' })
          }}
        >
          Clear filters
        </button>
      </form>
      {error && (
        <p className="subscription-warning" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p role="status">{data ? 'Refreshing the recorded snapshot…' : 'Reading subscriptions…'}</p>
      )}
      {data && (
        <>
          {stale && (
            <p className="subscription-warning" role="alert">
              This snapshot is over three minutes old or has an invalid clock. Refresh before
              relying on its status.
            </p>
          )}
          {data.stripeWorkPending && (
            <p className="subscription-warning" role="status">
              Stripe events are still awaiting processing or need attention. These are the currently
              recorded subscriptions; counts and statuses may change.
            </p>
          )}
          <div className="subscription-summary" aria-label="Counts for current filters">
            {[
              ['Matching subscriptions', data.total],
              ['Active', data.summary.active],
              ['Trialing', data.summary.trialing],
              ['Payment attention', data.summary.paymentAttention],
              ['Cancelled', data.summary.cancelled],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="subscription-caption">
            Counts use the current filters. Payment attention includes incomplete, past-due and
            unpaid subscriptions. Snapshot: {date(data.generatedAt)}.
          </p>
          {!data.items.length ? (
            <div className="subscription-empty">
              <Boxes size={28} aria-hidden="true" />
              <h2>{data.total ? 'No subscriptions on this page' : 'No matching subscriptions'}</h2>
              <p>Try changing the filters. Only normalized subscription records appear here.</p>
            </div>
          ) : (
            <div
              className="subscription-table-wrap"
              tabIndex={0}
              role="region"
              aria-label="Subscriptions table, scroll horizontally on small screens"
            >
              <table>
                <caption className="sr-only">
                  Recorded subscriptions matching the current filters
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Subscription</th>
                    <th scope="col">Partner / source</th>
                    <th scope="col">Status</th>
                    <th scope="col">Period end</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <strong>{item.productName}</strong>
                        <code>{item.stripeId}</code>
                        {item.zeroTotalCheckout && (
                          <span className="subscription-zero">Zero-total initial checkout</span>
                        )}
                      </th>
                      <td>
                        <strong>{item.partnerName ?? 'Not recorded'}</strong>
                        <span>{item.sourceName ?? 'Source not recorded'}</span>
                      </td>
                      <td>
                        <span className={`subscription-status subscription-status-${item.status}`}>
                          {SUBSCRIPTION_LABELS[item.status]}
                        </span>
                      </td>
                      <td>{date(item.periodEnd)}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-secondary-button"
                          aria-label={`View subscription ${item.stripeId}`}
                          onClick={() => setSelected(item)}
                        >
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className="subscription-pagination" aria-label="Subscription pages">
            <button
              type="button"
              className="admin-secondary-button"
              disabled={loading || offset === 0}
              onClick={() => change({ offset: Math.max(0, offset - PAGE_SIZE) })}
            >
              Previous
            </button>
            <span role="status">
              {data.items.length
                ? `${offset + 1}–${offset + data.items.length} of ${data.total}`
                : `0 on this page · ${data.total} matching`}
            </span>
            <button
              type="button"
              className="admin-secondary-button"
              disabled={loading || offset + PAGE_SIZE >= data.total}
              onClick={() => change({ offset: offset + PAGE_SIZE })}
            >
              Next
            </button>
          </nav>
        </>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title="Subscription details"
        description="Recorded billing and acquisition evidence. All timestamps are UTC."
        wide
        className="subscription-dialog"
      >
        {selected && <SubscriptionDetail item={selected} />}
      </Dialog>
    </section>
  )
}

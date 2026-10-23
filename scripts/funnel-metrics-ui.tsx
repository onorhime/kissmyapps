/** Development-only entry. Not included in Vite's production build inputs. */
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import '../src/App.css'
import '../src/features/partner/Reporting.css'
import '../src/brand.css'
import '../src/features/admin/AdminPortal.css'
import { createFunnelMetricsGateway } from '../src/features/funnel-metrics'
import { FunnelMetricsPanel } from '../src/features/funnel-metrics/admin/FunnelMetricsPanel'
import { FunnelMetricsReport } from '../src/features/partner/live/FunnelMetricsReport'
import { createLoadingPartnerLiveSnapshot } from '../src/features/partner/live/loader'
import type { PartnerProduct, PartnerLink } from '../src/features/partner/api'
import {
  createSettlementGateway,
  type SettlementClient,
} from '../src/features/creator-settlements/gateway'
import { AdminSettlementsPanel } from '../src/features/creator-settlements/AdminSettlementsPanel'
import { CreatorEarningsPanel } from '../src/features/creator-settlements/CreatorEarningsPanel'
const products = [
  {
    id: 'ac570000-0000-4000-8000-000000000001',
    funnel: 'ac570000-0000-4000-8000-000000000002',
    link: 'ac570000-0000-4000-8000-000000000004',
    name: 'SpeakSix marathon',
    funnelName: 'Webinar to marathon',
  },
  {
    id: 'ac570000-0000-4000-8000-000000000041',
    funnel: 'ac570000-0000-4000-8000-000000000042',
    link: 'ac570000-0000-4000-8000-000000000044',
    name: 'Generic course',
    funnelName: 'Course launch',
  },
]
const ready = <T,>(data: T) => ({ data, status: 'ready' as const, error: null })
export function Harness() {
  const [identity, setIdentity] = useState('admin'),
    [surface, setSurface] = useState('metrics'),
    [index, setIndex] = useState(0),
    [open, setOpen] = useState(true),
    choice = products[index]
  const client = useMemo<SettlementClient>(
    () => ({
      async rpc(name, args) {
        return fetch(`http://127.0.0.1:3204/rpc/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fixture-identity': identity },
          body: JSON.stringify(args),
        }).then((r) => r.json())
      },
    }),
    [identity],
  )
  const gateway = useMemo(() => createFunnelMetricsGateway(client), [client])
  const settlementGateway = useMemo(() => createSettlementGateway(client), [client])
  const workspace = useMemo(() => {
    const product: PartnerProduct = {
      id: choice.id,
      slug: index ? 'generic-course-fixture' : 'external-marathon-fixture',
      name: choice.name,
      status: 'active',
      trackingMode: 'commercial',
      agreementStatus: 'active',
      commercialModel: 'revenue_share',
      payoutCurrency: 'USD',
      hasLiveFunnel: true,
      mainLinkId: null,
      mainTrackingUrl: null,
    }
    const link: PartnerLink = {
      id: choice.link,
      name: 'Fixture creator link',
      productId: choice.id,
      productName: choice.name,
      productSlug: product.slug,
      funnelId: choice.funnel,
      funnelName: choice.funnelName,
      sourceId: null,
      sourceName: null,
      campaignId: null,
      campaignName: null,
      sub1: 'fixture',
      sub2: '',
      sub3: '',
      status: 'paused',
      trackingUrl: 'https://tracking.example.invalid/r/local-fixture',
      parentLinkId: null,
      commercialEligible: false,
      clicks: 1,
      leads: null,
      installs: null,
      purchases: null,
      earningsMinor: null,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    }
    const snapshot = createLoadingPartnerLiveSnapshot(choice.id),
      today = new Date().toISOString().slice(0, 10)
    return {
      selectedProductId: choice.id,
      sessionUserId: identity,
      client: null,
      reporting: {
        startsOn: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
        endsOn: today,
        timezone: 'UTC',
        grain: 'day' as const,
        breakdown: 'source' as const,
      },
      snapshot: {
        ...snapshot,
        resources: {
          ...snapshot.resources,
          products: ready([product]),
          linkDirectory: ready({
            products: [product],
            sources: [],
            campaigns: [],
            funnels: [
              {
                id: choice.funnel,
                productId: choice.id,
                kind: 'funnel' as const,
                key: index ? 'course' : 'webinar',
                name: choice.funnelName,
                available: true,
              },
            ],
          }),
          links: ready(identity === 'other' ? [] : [link]),
        },
      },
    }
  }, [choice, identity, index])
  return (
    <main
      className={identity === 'admin' ? 'admin-portal' : undefined}
      style={{ maxWidth: 1250, margin: '24px auto', padding: 24 }}
    >
      <h1>Local funnel metrics test</h1>
      <p role="note">
        Isolated PostgreSQL fixture. The editor and reports below use real RPCs. These identities
        and events are test data; no hosted services are connected.
      </p>
      <div style={{ display: 'flex', gap: 24, margin: '24px 0', flexWrap: 'wrap' }}>
        <label>
          Test surface{' '}
          <select value={surface} onChange={(e) => setSurface(e.target.value)}>
            <option value="metrics">Funnel metrics</option>
            <option value="settlements">Creator commissions and payouts</option>
          </select>
        </label>
        <label>
          Fixture identity{' '}
          <select value={identity} onChange={(e) => setIdentity(e.target.value)}>
            <option value="admin">Administrator</option>
            <option value="creator">Attributed creator</option>
            <option value="other">Unrelated creator</option>
          </select>
        </label>
        <label>
          Product{' '}
          <select
            value={index}
            onChange={(e) => {
              setIndex(Number(e.target.value))
              setOpen(true)
            }}
          >
            {products.map((p, i) => (
              <option key={p.id} value={i}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!open && <button onClick={() => setOpen(true)}>Open metric editor</button>}
      </div>
      {surface === 'settlements' ? (
        identity === 'admin' ? (
          <AdminSettlementsPanel key={identity} canWrite gateway={settlementGateway} />
        ) : (
          <CreatorEarningsPanel
            key={`${identity}:${choice.id}`}
            productId={choice.id}
            client={null}
            gateway={settlementGateway}
          />
        )
      ) : identity === 'admin' ? (
        open && (
          <FunnelMetricsPanel
            key={choice.id}
            productId={choice.id}
            funnelId={choice.funnel}
            funnelName={choice.funnelName}
            canManage
            onClose={() => setOpen(false)}
            gateway={gateway}
          />
        )
      ) : (
        <FunnelMetricsReport workspace={workspace} gateway={gateway} />
      )}
    </main>
  )
}
if (!import.meta.env.DEV || !['127.0.0.1', 'localhost'].includes(location.hostname))
  throw Error('Local acceptance harness only.')
const acceptanceRoot = createRoot(document.getElementById('root')!)
acceptanceRoot.render(<Harness />)
if (import.meta.hot) import.meta.hot.dispose(() => acceptanceRoot.unmount())

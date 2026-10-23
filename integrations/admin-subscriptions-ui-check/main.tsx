// Development-only fixture: no Supabase, Stripe or email requests.
import { createRoot } from 'react-dom/client'
import { SubscriptionsPage } from '../../src/features/admin/subscriptions/SubscriptionsPage'
import { subscriptionResponse } from '../../src/features/admin/subscriptions/fixtures'
import { mapAdminSubscriptionPage } from '../../src/features/admin/api/subscriptions'
import type { AdminGateway, AdminProduct } from '../../src/features/admin/api'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/features/admin/AdminPortal.css'
import '../../src/brand.css'
const state = new URLSearchParams(location.search).get('state') ?? 'ready'
const gateway = {
  async getSubscriptions() {
    if (state === 'error') return { status: 'error', error: null, data: null }
    const data = subscriptionResponse()
    if (state === 'empty') {
      data.items = []
      data.total = 0
      data.summary.active = 0
    }
    if (state === 'pending') data.stripe_work_pending = true
    return { status: 'ready', error: null, data: mapAdminSubscriptionPage(data) }
  },
} as AdminGateway
const product = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'BC Learn fixture',
} as AdminProduct
createRoot(document.getElementById('root')!).render(
  <div className="admin-portal">
    <main style={{ maxWidth: 1300, margin: 'auto', padding: 20 }}>
      <p>LOCAL VISUAL CHECK · Synthetic records only</p>
      <SubscriptionsPage gateway={gateway} products={[product]} role="owner" />
    </main>
  </div>,
)

// Local fixture only. No network, credentials, production operations or transfers.
import { createRoot } from 'react-dom/client'
import { PayoutsPage } from '../../src/features/admin/payouts/PayoutsPage'
import {
  workspaceFixture,
  statementFixture,
  fixtureId,
} from '../../src/features/admin/payouts/fixtures'
import type { AdminGateway } from '../../src/features/admin/api/types'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/features/admin/AdminPortal.css'
import '../../src/brand.css'
const state = new URLSearchParams(location.search).get('state')
const gateway = {
  async getPayoutWorkspace() {
    const data = workspaceFixture()
    if (state === 'empty') {
      data.periods = []
      data.items = []
      data.total = 0
      data.selected_period_id = null
    }
    if (state === 'error') throw Error('Synthetic unavailable state')
    return { status: 'ready', data, error: null }
  },
  async getPayoutStatement() {
    return { status: 'ready', data: statementFixture(), error: null }
  },
  async performPayoutAction(input) {
    return {
      status: 'ready',
      data: {
        request_id: input.request_id,
        id: input.id ?? fixtureId,
        action: input.action,
        external_transfer: false,
      },
      error: null,
    }
  },
} as AdminGateway
createRoot(document.getElementById('root')!).render(
  <div className="admin-portal">
    <main style={{ maxWidth: 1300, margin: 'auto', padding: 20 }}>
      <p>LOCAL QA · Synthetic records only · No production requests</p>
      <PayoutsPage gateway={gateway} role="owner" />
    </main>
  </div>,
)

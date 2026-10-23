// Development-only synthetic fixture. Not a build entrypoint. No live calls.
import { createRoot } from 'react-dom/client'
import type { AdminGateway } from '../../src/features/admin/api'
import { mapAdminProcessingHealth } from '../../src/features/admin/api/processingHealth'
import { ProcessingHealth } from '../../src/features/admin/observability/ProcessingHealth'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/features/admin/AdminPortal.css'
import '../../src/brand.css'

const state = new URLSearchParams(location.search).get('state') ?? 'healthy'
const warning = state === 'warning'
const gateway = {
  async getProcessingHealth() {
    if (state === 'unavailable') return { status: 'error', data: null, error: null }
    const now = new Date().toISOString()
    return {
      status: 'ready',
      error: null,
      data: mapAdminProcessingHealth({
        generated_at: now,
        attention_required: warning,
        reasons: warning ? ['scheduler_paused', 'recent_worker_issue'] : [],
        enabled: !warning,
        current_worker: 'metrics-worker',
        last_tick_at: now,
        last_cycle_at: now,
        external_alerts_configured: false,
        queues: ['stripe', 'commercial', 'metrics'].map((worker) => ({
          worker,
          pending: 0,
          processing: 0,
          failed: 0,
          expired_leases: 0,
          oldest_unfinished_at: null,
        })),
        last_incident: warning
          ? {
              run_id: '10000000-0000-4000-8000-000000000001',
              worker: 'metrics-worker',
              outcome: 'failed',
              dispatched_at: now,
              finished_at: now,
              error_code: 'worker_http_failure',
              diagnostic_code: 'worker_http_failure',
              dispatch_http_status: 503,
              upstream_http_status: 502,
              duration_ms: 100,
            }
          : null,
      }),
    }
  },
} as AdminGateway

createRoot(document.getElementById('root')!).render(
  <div className="admin-portal">
    <main style={{ maxWidth: 1250, margin: 'auto', padding: 20 }}>
      <h1>Local processing-health UI check</h1>
      <p>Synthetic records only. No Stripe, Supabase, email or worker calls.</p>
      <nav aria-label="Fixture state" style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        <a href="?state=healthy">Healthy</a>
        <a href="?state=warning">Warning</a>
        <a href="?state=unavailable">Unavailable</a>
      </nav>
      <ProcessingHealth gateway={gateway} />
    </main>
  </div>,
)

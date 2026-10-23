// Developer-only fixture; not a production build entrypoint. No live gateway.
import { createRoot } from 'react-dom/client'
import { ProductConfigurationPage } from '../../src/features/admin/configuration/ProductConfigurationPage'
import { auditGateway, configuration, owner } from './fixture'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/features/admin/AdminPortal.css'
import '../../src/brand.css'

const gateway = auditGateway(1500)
createRoot(document.getElementById('root')!).render(
  <div className="admin-portal">
    <main
      id="admin-main-content"
      tabIndex={-1}
      style={{ maxWidth: 1320, margin: 'auto', padding: '24px' }}
    >
      <p>LOCAL AUDIT · Synthetic records only · No live account, Stripe, or Supabase writes</p>
      <ProductConfigurationPage
        productId={configuration.product.id}
        context={owner}
        gateway={gateway}
        onBack={() => {}}
      />
    </main>
  </div>,
)

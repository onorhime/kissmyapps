import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isMarketplacePath } from './features/marketplace/routing'
import { isMerchantConsole } from './merchant/host'

const root = createRoot(document.getElementById('root')!)

if (isMarketplacePath(window.location.pathname)) {
  // The public marketplace is served at /marketplace on every host and needs no session.
  void import('./features/marketplace/PublicMarketplace').then(({ PublicMarketplace }) =>
    root.render(
      <StrictMode>
        <PublicMarketplace />
      </StrictMode>,
    ),
  )
} else if (isMerchantConsole(window.location)) {
  // The merchant console ships as its own chunk, so partner and admin users never load it.
  void import('./merchant/MerchantApp').then(({ MerchantApp }) =>
    root.render(
      <StrictMode>
        <MerchantApp />
      </StrictMode>,
    ),
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

export { AdminPortalApp } from './AdminPortalApp'
export type {
  AdminIdentity,
  AdminPortalAppProps,
  AdminPrimaryRoute,
  AdminRoute,
} from './AdminPortalApp'
export { AdminOverview } from './AdminOverview'
export { AffiliatesPage } from './affiliates/AffiliatesPage'
export type { AffiliatesPageProps } from './affiliates/AffiliatesPage'
export {
  activationStatusLabel,
  affiliateStatusLabel,
  confirmationStatusLabel,
  formatAdminTimestamp,
  registrationKindLabel,
} from './affiliates/affiliatePresentation'
export { ProductConfigurationPage } from './configuration/ProductConfigurationPage'
export type { ProductConfigurationPageProps } from './configuration/ProductConfigurationPage'
export { FunnelsLinksPage } from './funnels/FunnelsLinksPage'
export type { FunnelsLinksPageProps } from './funnels/FunnelsLinksPage'
export {
  mainLinkReadiness,
  productActivationReadiness,
  readinessCopy,
} from './configuration/readiness'
export { ProductsPage } from './products/ProductsPage'
export type { ProductsPageProps } from './products/ProductsPage'
export {
  normalizeProductDraft,
  slugifyProductName,
  validateProductDraft,
} from './products/productValidation'
export * from './api'

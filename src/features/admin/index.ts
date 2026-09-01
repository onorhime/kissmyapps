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
export { AttributionPage } from './observability/AttributionPage'
export type { AttributionPageProps } from './observability/AttributionPage'
export { DataHealthPage } from './observability/DataHealthPage'
export type { DataHealthPageProps } from './observability/DataHealthPage'
export { PlatformSettingsPage } from './settings/PlatformSettingsPage'
export type { PlatformSettingsPageProps } from './settings/PlatformSettingsPage'
export {
  dataHealthStatusLabel,
  formatAdminCount,
  formatAdminOperationalTimestamp,
  providerLabel,
  queueLabel,
} from './observability/observabilityPresentation'
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

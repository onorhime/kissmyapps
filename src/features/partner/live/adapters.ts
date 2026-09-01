import type { PartnerCommissionModel, PartnerProduct } from '../api'
import type { PartnerLiveWorkspaceAvailability, PartnerLiveWorkspaceSnapshot } from './types'

export type PartnerLiveProductOption = Readonly<{
  id: string
  name: string
  status: PartnerProduct['status']
}>

export type PartnerLiveWorkspaceContextModel = Readonly<{
  partnerName: string | null
  partnerRole: string | null
  partnerStatus: string | null
  products: readonly PartnerLiveProductOption[]
  selectedProduct: PartnerProduct | null
  commercialModel: PartnerCommissionModel | null
  payoutCurrency: string | null
  agreementStatus: PartnerProduct['agreementStatus'] | null
  mainTrackingUrl: string | null
  canCreateLinks: boolean
  availability: PartnerLiveWorkspaceAvailability
}>

/**
 * This adapter exposes only fields that have a direct live-data equivalent.
 * It intentionally does not convert live links or payouts into the legacy
 * PreviewLink/PreviewPayout shapes: those types cannot represent nullable live
 * metrics and would turn unavailable values into fictional zeroes.
 */
export function toPartnerLiveWorkspaceContext(
  snapshot: PartnerLiveWorkspaceSnapshot,
  selectedProductId: string | null,
): PartnerLiveWorkspaceContextModel {
  const selectedProduct =
    snapshot.resources.products.data.find((product) => product.id === selectedProductId) ?? null

  return {
    partnerName: snapshot.resources.profile.data?.publicName ?? null,
    partnerRole: snapshot.resources.profile.data?.role ?? null,
    partnerStatus: snapshot.resources.profile.data?.status ?? null,
    products: snapshot.resources.products.data.map(({ id, name, status }) => ({
      id,
      name,
      status,
    })),
    selectedProduct,
    commercialModel: selectedProduct?.commercialModel ?? null,
    payoutCurrency: selectedProduct?.payoutCurrency ?? null,
    agreementStatus: selectedProduct?.agreementStatus ?? null,
    mainTrackingUrl: selectedProduct?.mainTrackingUrl ?? null,
    canCreateLinks:
      selectedProduct?.mainLinkId !== null &&
      selectedProduct?.mainLinkId !== undefined &&
      selectedProduct.mainTrackingUrl !== null &&
      snapshot.availability.funnels === 'available',
    availability: snapshot.availability,
  }
}

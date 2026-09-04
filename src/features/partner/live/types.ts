import type { ReactNode } from 'react'
import type {
  PartnerAgreement,
  PartnerDashboardSummary,
  PartnerDataError,
  PartnerDataGateway,
  PartnerDataResult,
  PartnerDocument,
  PartnerLink,
  PartnerLinkCreate,
  PartnerLinkDirectory,
  PartnerLinkStatus,
  PartnerLinkUpdate,
  PartnerPayout,
  PartnerPayoutDetail,
  PartnerPayoutSummary,
  PartnerProduct,
  PartnerProfile,
  PartnerProfileUpdate,
  PartnerSettingsUpdate,
  PartnerSupabaseClient,
  PartnerTrendPoint,
  PartnerTrendQuery,
} from '../api'

export type PartnerLiveResourceStatus =
  'loading' | 'ready' | 'empty' | 'unconfigured' | 'unavailable' | 'error'

export type PartnerLiveWorkspaceStatus =
  'loading' | 'ready' | 'ready-empty' | 'partial' | 'unavailable' | 'unconfigured' | 'error'

export type PartnerLiveResource<T> = Readonly<{
  data: T
  status: PartnerLiveResourceStatus
  error: PartnerDataError | null
}>

export type PartnerLiveResources = Readonly<{
  profile: PartnerLiveResource<PartnerProfile | null>
  products: PartnerLiveResource<readonly PartnerProduct[]>
  linkDirectory: PartnerLiveResource<PartnerLinkDirectory>
  links: PartnerLiveResource<readonly PartnerLink[]>
  payoutSummary: PartnerLiveResource<PartnerPayoutSummary>
  payoutHistory: PartnerLiveResource<readonly PartnerPayout[]>
  documents: PartnerLiveResource<readonly PartnerDocument[]>
  agreements: PartnerLiveResource<readonly PartnerAgreement[]>
  dashboardSummary: PartnerLiveResource<PartnerDashboardSummary>
  dashboardTrends: PartnerLiveResource<readonly PartnerTrendPoint[]>
}>

export type PartnerLiveResourceKey = keyof PartnerLiveResources

export type PartnerLiveAvailability = 'available' | 'none' | 'unknown'

export type PartnerLiveEmptyReason =
  'no_partner_profile' | 'no_products' | 'no_funnels' | 'no_activity' | null

export type PartnerLiveWorkspaceAvailability = Readonly<{
  profile: PartnerLiveAvailability
  products: PartnerLiveAvailability
  funnels: PartnerLiveAvailability
  activity: PartnerLiveAvailability
  emptyReason: PartnerLiveEmptyReason
}>

export type PartnerLiveWorkspaceSnapshot = Readonly<{
  status: PartnerLiveWorkspaceStatus
  resources: PartnerLiveResources
  availability: PartnerLiveWorkspaceAvailability
  errors: readonly PartnerDataError[]
}>

/**
 * The app supplies the reporting window and dimensions. The live workspace adds
 * the currently selected product before calling the two reporting RPCs.
 */
export type PartnerLiveReportingQuery = Readonly<Omit<PartnerTrendQuery, 'productId'>>

export type PartnerLiveLoadRequest = Readonly<{
  productId: string | null
  reporting: PartnerLiveReportingQuery
}>

export type PartnerLiveMutationOperation =
  | 'create-link'
  | 'update-link'
  | 'set-link-status'
  | 'update-profile'
  | 'update-settings'
  | 'load-payout-detail'

export type PartnerLiveMutationState = Readonly<{
  status: 'idle' | 'pending' | 'complete' | 'failed'
  operation: PartnerLiveMutationOperation | null
  error: PartnerDataError | null
}>

export type PartnerPayoutDetailResult = Readonly<{
  detail: PartnerPayoutDetail | null
  status: Exclude<PartnerLiveResourceStatus, 'loading'>
  error: PartnerDataError | null
}>

export type PartnerLiveWorkspaceActions = Readonly<{
  refresh: () => void
  selectProduct: (productId: string | null) => void
  createLink: (input: PartnerLinkCreate) => Promise<PartnerDataResult<PartnerLink | null>>
  updateLink: (
    linkId: string,
    patch: PartnerLinkUpdate,
  ) => Promise<PartnerDataResult<PartnerLink | null>>
  setLinkStatus: (
    linkId: string,
    status: PartnerLinkStatus,
  ) => Promise<PartnerDataResult<PartnerLink | null>>
  updateProfile: (
    profile: PartnerProfileUpdate,
  ) => Promise<PartnerDataResult<PartnerProfile | null>>
  updateSettings: (
    settings: PartnerSettingsUpdate,
  ) => Promise<PartnerDataResult<PartnerProfile | null>>
  loadPayoutDetail: (payoutId: string) => Promise<PartnerPayoutDetailResult>
}>

export type PartnerLiveWorkspaceValue = Readonly<{
  snapshot: PartnerLiveWorkspaceSnapshot
  selectedProductId: string | null
  isRefreshing: boolean
  mutation: PartnerLiveMutationState
  actions: PartnerLiveWorkspaceActions
  /** The resolved gateway, exposed for self-contained capability surfaces. */
  gateway: PartnerDataGateway
}>

export type PartnerLiveWorkspaceProviderProps = Readonly<{
  children: ReactNode
  client?: PartnerSupabaseClient | null
  sessionUserId: string | null
  reporting: PartnerLiveReportingQuery
  initialProductId?: string | null
  /** Test/composition seam. When present, this gateway is used instead of `client`. */
  gateway?: PartnerDataGateway
}>

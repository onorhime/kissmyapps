import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataError,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerLinkDirectory,
  type PartnerProduct,
} from '../api'
import type {
  PartnerLiveLoadRequest,
  PartnerLiveResource,
  PartnerLiveResources,
  PartnerLiveResourceStatus,
  PartnerLiveWorkspaceSnapshot,
  PartnerLiveWorkspaceStatus,
} from './types'

const emptyLinkDirectory = (): PartnerLinkDirectory => ({
  products: [],
  funnels: [],
  sources: [],
  campaigns: [],
})

const unavailableError = (): PartnerDataError => ({
  code: 'temporarily_unavailable',
  message: 'Partner data is temporarily unavailable.',
  retryable: true,
})

const notAuthenticatedError = (): PartnerDataError => ({
  code: 'not_authenticated',
  message: 'Sign in to access partner data.',
  retryable: false,
})

const unconfiguredError = (): PartnerDataError => ({
  code: 'not_configured',
  message: 'The partner data connection is not configured.',
  retryable: false,
})

function resource<T>(
  data: T,
  status: PartnerLiveResourceStatus,
  error: PartnerDataError | null = null,
): PartnerLiveResource<T> {
  return { data, status, error }
}

function statusFromResult<T>(result: PartnerDataResult<T>): PartnerLiveResourceStatus {
  if (result.status === 'error' && result.error?.retryable) return 'unavailable'
  return result.status
}

function fromResult<T>(result: PartnerDataResult<T>): PartnerLiveResource<T> {
  return resource(result.data, statusFromResult(result), result.error)
}

async function safely<T>(
  read: () => Promise<PartnerDataResult<T>>,
  fallback: () => T,
): Promise<PartnerLiveResource<T>> {
  try {
    return fromResult(await read())
  } catch {
    return resource(fallback(), 'unavailable', unavailableError())
  }
}

function resourceErrors(resources: PartnerLiveResources): readonly PartnerDataError[] {
  const unique = new Map<string, PartnerDataError>()
  for (const item of Object.values(resources)) {
    if (!item.error) continue
    const key = `${item.error.code}:${item.error.message}:${String(item.error.retryable)}`
    unique.set(key, item.error)
  }
  return [...unique.values()]
}

export function derivePartnerLiveWorkspaceStatus(
  resources: PartnerLiveResources,
): PartnerLiveWorkspaceStatus {
  const statuses = Object.values(resources).map((item) => item.status)
  if (statuses.some((status) => status === 'loading')) return 'loading'
  if (statuses.every((status) => status === 'unconfigured')) return 'unconfigured'

  const usable = statuses.filter((status) => status === 'ready' || status === 'empty')
  const unavailable = statuses.filter((status) => status === 'unavailable')
  const errors = statuses.filter((status) => status === 'error')
  const unconfigured = statuses.filter((status) => status === 'unconfigured')

  if (errors.length || unavailable.length || unconfigured.length) {
    if (usable.length) return 'partial'
    if (unavailable.length === statuses.length) return 'unavailable'
    return 'error'
  }

  if (resources.profile.status === 'empty' || resources.products.status === 'empty') {
    return 'ready-empty'
  }
  return 'ready'
}

function known(status: PartnerLiveResourceStatus): boolean {
  return status === 'ready' || status === 'empty'
}

export function derivePartnerLiveWorkspaceAvailability(
  resources: PartnerLiveResources,
  selectedProductId: string | null,
) {
  const profile = known(resources.profile.status)
    ? resources.profile.data
      ? ('available' as const)
      : ('none' as const)
    : ('unknown' as const)
  const products = known(resources.products.status)
    ? resources.products.data.length
      ? ('available' as const)
      : ('none' as const)
    : ('unknown' as const)
  const availableFunnels = resources.linkDirectory.data.funnels.filter(
    (option) =>
      option.available &&
      (selectedProductId === null ||
        option.productId === null ||
        option.productId === selectedProductId),
  )
  const funnels = known(resources.linkDirectory.status)
    ? availableFunnels.length
      ? ('available' as const)
      : ('none' as const)
    : ('unknown' as const)
  const activity = known(resources.dashboardSummary.status)
    ? resources.dashboardSummary.data.hasData
      ? ('available' as const)
      : ('none' as const)
    : ('unknown' as const)

  const emptyReason =
    profile === 'none'
      ? ('no_partner_profile' as const)
      : products === 'none'
        ? ('no_products' as const)
        : funnels === 'none'
          ? ('no_funnels' as const)
          : activity === 'none'
            ? ('no_activity' as const)
            : null

  return { profile, products, funnels, activity, emptyReason }
}

export function createPartnerLiveSnapshot(
  resources: PartnerLiveResources,
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  return {
    status: derivePartnerLiveWorkspaceStatus(resources),
    resources,
    availability: derivePartnerLiveWorkspaceAvailability(resources, selectedProductId),
    errors: resourceErrors(resources),
  }
}

export function createLoadingPartnerLiveSnapshot(
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  const resources: PartnerLiveResources = {
    profile: resource(null, 'loading'),
    products: resource([], 'loading'),
    linkDirectory: resource(emptyLinkDirectory(), 'loading'),
    links: resource([], 'loading'),
    payoutSummary: resource(emptyPartnerPayoutSummary(), 'loading'),
    payoutHistory: resource([], 'loading'),
    documents: resource([], 'loading'),
    agreements: resource([], 'loading'),
    dashboardSummary: resource(emptyPartnerDashboardSummary(), 'loading'),
    dashboardTrends: resource([], 'loading'),
  }
  return createPartnerLiveSnapshot(resources, selectedProductId)
}

function createUniformPartnerLiveSnapshot(
  selectedProductId: string | null,
  status: 'unconfigured' | 'error',
  error: PartnerDataError,
): PartnerLiveWorkspaceSnapshot {
  const resources: PartnerLiveResources = {
    profile: resource(null, status, error),
    products: resource([], status, error),
    linkDirectory: resource(emptyLinkDirectory(), status, error),
    links: resource([], status, error),
    payoutSummary: resource(emptyPartnerPayoutSummary(), status, error),
    payoutHistory: resource([], status, error),
    documents: resource([], status, error),
    agreements: resource([], status, error),
    dashboardSummary: resource(emptyPartnerDashboardSummary(), status, error),
    dashboardTrends: resource([], status, error),
  }
  return createPartnerLiveSnapshot(resources, selectedProductId)
}

export function createUnauthenticatedPartnerLiveSnapshot(
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  return createUniformPartnerLiveSnapshot(selectedProductId, 'error', notAuthenticatedError())
}

export function createUnconfiguredPartnerLiveSnapshot(
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  return createUniformPartnerLiveSnapshot(selectedProductId, 'unconfigured', unconfiguredError())
}

export async function loadPartnerLiveWorkspace(
  gateway: PartnerDataGateway,
  request: PartnerLiveLoadRequest,
  prefetchedProducts?: PartnerLiveResource<readonly PartnerProduct[]>,
): Promise<PartnerLiveWorkspaceSnapshot> {
  const profile = await safely(
    () => gateway.getCurrentPartnerProfile(),
    () => null,
  )
  const authoritativeTimezone =
    profile.status === 'ready' && profile.data ? profile.data.timezone : request.reporting.timezone
  const { grain, breakdown, ...dashboardQuery } = {
    ...request.reporting,
    timezone: authoritativeTimezone,
  }
  const scopedDashboardQuery = { ...dashboardQuery, productId: request.productId }

  const [
    products,
    linkDirectory,
    links,
    payoutSummary,
    payoutHistory,
    documents,
    agreements,
    dashboardSummary,
    dashboardTrends,
  ] = await Promise.all([
    prefetchedProducts ?? loadPartnerLiveProducts(gateway),
    safely(() => gateway.getLinkDirectory(), emptyLinkDirectory),
    safely(
      () => gateway.getPartnerLinks(request.productId),
      () => [],
    ),
    safely(() => gateway.getPayoutSummary(request.productId), emptyPartnerPayoutSummary),
    safely(
      () => gateway.getPayoutHistory(request.productId),
      () => [],
    ),
    safely(
      // Documents belong to the partner account, including unlaunched and
      // historical products outside the currently selected reporting scope.
      () => gateway.getDocuments(),
      () => [],
    ),
    safely(
      () => gateway.getAgreements(request.productId),
      () => [],
    ),
    safely(() => gateway.getDashboardSummary(scopedDashboardQuery), emptyPartnerDashboardSummary),
    safely(
      () =>
        gateway.getDashboardTrends({
          ...scopedDashboardQuery,
          grain,
          breakdown,
        }),
      () => [],
    ),
  ])

  return createPartnerLiveSnapshot(
    {
      profile,
      products,
      linkDirectory,
      links,
      payoutSummary,
      payoutHistory,
      documents,
      agreements,
      dashboardSummary,
      dashboardTrends,
    },
    request.productId,
  )
}

export function loadPartnerLiveProducts(
  gateway: PartnerDataGateway,
): Promise<PartnerLiveResource<readonly PartnerProduct[]>> {
  return safely<readonly PartnerProduct[]>(
    () => gateway.getProducts(),
    () => [],
  )
}

export function unavailablePartnerDataResult<T>(fallback: T): PartnerDataResult<T> {
  return { data: fallback, status: 'error', error: unavailableError() }
}

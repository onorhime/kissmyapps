import { useCallback, useEffect, useState } from 'react'
import type { AdminGateway, AdminProduct, AdminProductConfiguration } from '../api'

export type FunnelsLinksOverviewStatus =
  'loading' | 'ready' | 'partial' | 'empty' | 'unconfigured' | 'error'

export type FunnelsLinksProductRow = Readonly<{
  product: AdminProduct
  configuration: AdminProductConfiguration
}>

export type FunnelsLinksOverviewTotals = Readonly<{
  products: number
  funnels: number
  liveDefaults: number
  mainLinks: number
}>

export type FunnelsLinksOverviewState = Readonly<{
  status: FunnelsLinksOverviewStatus
  rows: readonly FunnelsLinksProductRow[]
  unavailableProductIds: readonly string[]
  totals: FunnelsLinksOverviewTotals
  refreshing: boolean
}>

type ConfigurationAttempt = Readonly<{
  product: AdminProduct
  configuration: AdminProductConfiguration | null
  failure: 'unconfigured' | 'unavailable' | null
}>

const zeroTotals: FunnelsLinksOverviewTotals = {
  products: 0,
  funnels: 0,
  liveDefaults: 0,
  mainLinks: 0,
}

function productScope(products: readonly AdminProduct[]): string {
  if (!products.length) return 'empty'
  return products
    .map((product) =>
      [product.id, product.name, product.slug, product.status, product.updatedAt].join('\u001e'),
    )
    .join('\u001f')
}

function loadingState(productCount: number): FunnelsLinksOverviewState {
  return {
    status: 'loading',
    rows: [],
    unavailableProductIds: [],
    totals: { ...zeroTotals, products: productCount },
    refreshing: false,
  }
}

function emptyState(): FunnelsLinksOverviewState {
  return {
    status: 'empty',
    rows: [],
    unavailableProductIds: [],
    totals: zeroTotals,
    refreshing: false,
  }
}

function unconfiguredState(productCount: number): FunnelsLinksOverviewState {
  return {
    status: 'unconfigured',
    rows: [],
    unavailableProductIds: [],
    totals: { ...zeroTotals, products: productCount },
    refreshing: false,
  }
}

function aggregate(
  productCount: number,
  rows: readonly FunnelsLinksProductRow[],
): FunnelsLinksOverviewTotals {
  return rows.reduce<FunnelsLinksOverviewTotals>(
    (totals, row) => ({
      products: totals.products,
      funnels: totals.funnels + row.configuration.funnels.length,
      liveDefaults:
        totals.liveDefaults + (row.configuration.readiness.hasLiveDefaultFunnel ? 1 : 0),
      mainLinks: totals.mainLinks + row.configuration.mainLinks.length,
    }),
    { ...zeroTotals, products: productCount },
  )
}

function isUnconfiguredFailure(code: string | undefined, status: string): boolean {
  return status === 'unconfigured' || code === 'not_configured' || code === 'contract_unavailable'
}

async function loadConfiguration(
  gateway: AdminGateway,
  product: AdminProduct,
): Promise<ConfigurationAttempt> {
  try {
    const result = await gateway.getProductConfiguration!(product.id)
    if (result.status === 'ready' && result.data && result.data.product.id === product.id) {
      return { product, configuration: result.data, failure: null }
    }
    return {
      product,
      configuration: null,
      failure: isUnconfiguredFailure(result.error?.code, result.status)
        ? 'unconfigured'
        : 'unavailable',
    }
  } catch {
    return { product, configuration: null, failure: 'unavailable' }
  }
}

export function hasFunnelsLinksReadCapability(
  gateway: AdminGateway,
): gateway is AdminGateway & Required<Pick<AdminGateway, 'getProductConfiguration'>> {
  return typeof gateway.getProductConfiguration === 'function'
}

export function useFunnelsLinksOverview({
  products,
  gateway,
}: {
  products: readonly AdminProduct[]
  gateway: AdminGateway
}) {
  const scope = productScope(products)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [scopedState, setScopedState] = useState<{
    scope: string
    value: FunnelsLinksOverviewState
  }>(() => ({ scope, value: products.length ? loadingState(products.length) : emptyState() }))
  const state = !products.length
    ? emptyState()
    : !hasFunnelsLinksReadCapability(gateway)
      ? unconfiguredState(products.length)
      : scopedState.scope === scope
        ? scopedState.value
        : loadingState(products.length)

  useEffect(() => {
    if (!products.length || !hasFunnelsLinksReadCapability(gateway)) return

    let active = true
    void (async () => {
      const attempts = await Promise.all(
        products.map((product) => loadConfiguration(gateway, product)),
      )
      if (!active) return

      const rows = attempts.flatMap((attempt) =>
        attempt.configuration
          ? [{ product: attempt.configuration.product, configuration: attempt.configuration }]
          : [],
      )
      const failures = attempts.filter((attempt) => attempt.failure !== null)
      const unavailableProductIds = failures.map((attempt) => attempt.product.id)
      const status: FunnelsLinksOverviewStatus = rows.length
        ? failures.length
          ? 'partial'
          : 'ready'
        : failures.length > 0 && failures.every((attempt) => attempt.failure === 'unconfigured')
          ? 'unconfigured'
          : 'error'

      setScopedState({
        scope,
        value: {
          status,
          rows,
          unavailableProductIds,
          totals: aggregate(products.length, rows),
          refreshing: false,
        },
      })
    })()

    return () => {
      active = false
    }
  }, [gateway, products, reloadVersion, scope])

  const retry = useCallback(() => {
    setScopedState((current) => {
      if (current.scope !== scope || !current.value.rows.length) {
        return { scope, value: loadingState(products.length) }
      }
      return { scope, value: { ...current.value, refreshing: true } }
    })
    setReloadVersion((version) => version + 1)
  }, [products.length, scope])

  return { state, retry }
}

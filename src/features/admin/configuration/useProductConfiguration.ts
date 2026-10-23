import { useCallback, useEffect, useState } from 'react'
import {
  type AdminAffiliate,
  type AdminConfigurationGateway,
  type AdminDataError,
  type AdminProduct,
  type AdminProductConfiguration,
  type AdminSource,
} from '../api'

export type ProductConfigurationStatus =
  'loading' | 'ready' | 'not_found' | 'unauthorized' | 'unconfigured' | 'error'

export type ProductConfigurationState = Readonly<{
  status: ProductConfigurationStatus
  configuration: AdminProductConfiguration | null
  affiliates: readonly AdminAffiliate[]
  sources: readonly AdminSource[]
  error: AdminDataError | null
  refreshing: boolean
}>

function loadingState(): ProductConfigurationState {
  return {
    status: 'loading',
    configuration: null,
    affiliates: [],
    sources: [],
    error: null,
    refreshing: false,
  }
}

function failedStatus(error: AdminDataError | null): ProductConfigurationStatus {
  if (error?.code === 'invalid_reference') return 'not_found'
  if (error?.code === 'not_authenticated' || error?.code === 'not_authorized') {
    return 'unauthorized'
  }
  if (error?.code === 'not_configured' || error?.code === 'contract_unavailable') {
    return 'unconfigured'
  }
  return 'error'
}

export function useProductConfiguration({
  productId,
  gateway,
  onProductRead,
}: {
  productId: string
  gateway?: AdminConfigurationGateway | null
  onProductRead?: (product: AdminProduct) => void
}) {
  const [reloadVersion, setReloadVersion] = useState(0)
  const [scopedState, setScopedState] = useState<{
    productId: string
    gateway: typeof gateway
    value: ProductConfigurationState
  }>(() => ({ productId, gateway, value: loadingState() }))
  const state = gateway
    ? scopedState.productId === productId && scopedState.gateway === gateway
      ? scopedState.value
      : loadingState()
    : {
        ...loadingState(),
        status: 'unconfigured' as const,
        error: {
          code: 'contract_unavailable' as const,
          message: 'The admin product configuration service is not available yet.',
          retryable: false,
        },
      }

  useEffect(() => {
    if (!gateway) return
    let active = true

    function fail(error: AdminDataError | null) {
      if (!active) return
      const status = failedStatus(error)
      setScopedState((current) => ({
        productId,
        gateway,
        value:
          status === 'error' &&
          current.productId === productId &&
          current.gateway === gateway &&
          current.value.configuration
            ? {
                ...current.value,
                refreshing: false,
                error: error ?? {
                  code: 'temporarily_unavailable',
                  message: 'Configuration refresh failed.',
                  retryable: true,
                },
              }
            : { ...loadingState(), status, error },
      }))
    }

    void (async () => {
      try {
        const configurationResult = await gateway.getProductConfiguration(productId)
        if (!active) return
        if (configurationResult.data && configurationResult.data.product.id !== productId) {
          fail({
            code: 'invalid_reference',
            message: 'Product configuration does not match this workspace.',
            retryable: false,
          })
          return
        }
        if (configurationResult.status !== 'ready' || !configurationResult.data) {
          fail(configurationResult.error)
          return
        }

        const [affiliatesResult, sourcesResult] = await Promise.all([
          gateway.getAffiliates(),
          gateway.getSources(),
        ])
        if (!active) return
        const affiliatesReady =
          affiliatesResult.status === 'ready' || affiliatesResult.status === 'empty'
        const sourcesReady = sourcesResult.status === 'ready' || sourcesResult.status === 'empty'
        if (!affiliatesReady || !sourcesReady) {
          const error = affiliatesReady ? sourcesResult.error : affiliatesResult.error
          fail(error)
          return
        }

        onProductRead?.(configurationResult.data.product)
        setScopedState({
          productId,
          gateway,
          value: {
            status: 'ready',
            configuration: configurationResult.data,
            affiliates: affiliatesResult.data,
            sources: sourcesResult.data,
            error: null,
            refreshing: false,
          },
        })
      } catch {
        fail({
          code: 'temporarily_unavailable',
          message: 'Configuration refresh failed. Your saved changes were not undone.',
          retryable: true,
        })
      }
    })()

    return () => {
      active = false
    }
  }, [gateway, onProductRead, productId, reloadVersion])

  const reload = useCallback(() => {
    setScopedState((current) => ({
      productId,
      gateway,
      value:
        current.productId === productId &&
        current.gateway === gateway &&
        current.value.configuration
          ? { ...current.value, refreshing: true, error: null }
          : loadingState(),
    }))
    setReloadVersion((version) => version + 1)
  }, [productId, gateway])

  const invalidate = (error: AdminDataError) =>
    setScopedState({
      productId,
      gateway,
      value: { ...loadingState(), status: failedStatus(error), error },
    })
  return { state, reload, invalidate }
}

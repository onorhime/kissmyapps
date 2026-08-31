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
}>

function loadingState(): ProductConfigurationState {
  return {
    status: 'loading',
    configuration: null,
    affiliates: [],
    sources: [],
    error: null,
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
    value: ProductConfigurationState
  }>(() => ({ productId, value: loadingState() }))
  const state = gateway
    ? scopedState.productId === productId
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

    void (async () => {
      const configurationResult = await gateway.getProductConfiguration(productId)
      if (!active) return
      if (configurationResult.status !== 'ready' || !configurationResult.data) {
        setScopedState({
          productId,
          value: {
            ...loadingState(),
            status: failedStatus(configurationResult.error),
            error: configurationResult.error,
          },
        })
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
        setScopedState({
          productId,
          value: {
            ...loadingState(),
            status: failedStatus(error),
            error,
          },
        })
        return
      }

      onProductRead?.(configurationResult.data.product)
      setScopedState({
        productId,
        value: {
          status: 'ready',
          configuration: configurationResult.data,
          affiliates: affiliatesResult.data,
          sources: sourcesResult.data,
          error: null,
        },
      })
    })()

    return () => {
      active = false
    }
  }, [gateway, onProductRead, productId, reloadVersion])

  const reload = useCallback(() => {
    setScopedState({ productId, value: loadingState() })
    setReloadVersion((version) => version + 1)
  }, [productId])

  return { state, reload }
}

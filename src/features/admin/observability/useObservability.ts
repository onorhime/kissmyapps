import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type AdminAttributionInput,
  type AdminAttributionOverview,
  type AdminDataError,
  type AdminDataResult,
  type AdminDataHealth,
  type AdminGateway,
} from '../api'

export type ObservabilityStatus = 'loading' | 'ready' | 'unconfigured' | 'unauthorized' | 'error'

export type ObservabilityState<T> = Readonly<{
  status: ObservabilityStatus
  data: T | null
  error: AdminDataError | null
  refreshing: boolean
}>

const unavailableError: AdminDataError = {
  code: 'temporarily_unavailable',
  message: 'Operational reporting is temporarily unavailable.',
  retryable: true,
}

const unconfiguredError: AdminDataError = {
  code: 'contract_unavailable',
  message: 'Operational reporting is not available in this deployment.',
  retryable: false,
}

function loading<T>(): ObservabilityState<T> {
  return { status: 'loading', data: null, error: null, refreshing: false }
}

function unconfigured<T>(): ObservabilityState<T> {
  return { status: 'unconfigured', data: null, error: unconfiguredError, refreshing: false }
}

function statusFromResult<T>(result: AdminDataResult<T | null>): ObservabilityState<T> {
  if (result.status === 'ready' && result.data) {
    return { status: 'ready', data: result.data, error: null, refreshing: false }
  }
  return {
    status:
      result.status === 'unconfigured' || result.error?.code === 'contract_unavailable'
        ? 'unconfigured'
        : result.status === 'unauthorized'
          ? 'unauthorized'
          : 'error',
    data: null,
    error: result.error ?? unavailableError,
    refreshing: false,
  }
}

type AttributionReader = Required<Pick<AdminGateway, 'getAttributionOverview'>>
type DataHealthReader = Required<Pick<AdminGateway, 'getDataHealth'>>

function attributionCapability(gateway: AdminGateway): AttributionReader | null {
  return typeof gateway.getAttributionOverview === 'function'
    ? (gateway as AttributionReader)
    : null
}

function dataHealthCapability(gateway: AdminGateway): DataHealthReader | null {
  return typeof gateway.getDataHealth === 'function' ? (gateway as DataHealthReader) : null
}

export function useAttributionOverview({
  gateway,
  input,
}: {
  gateway: AdminGateway
  input: AdminAttributionInput
}) {
  const observabilityGateway = useMemo(() => attributionCapability(gateway), [gateway])
  const scope = JSON.stringify(input)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [scopedState, setScopedState] = useState<{
    gateway: AttributionReader | null
    scope: string
    value: ObservabilityState<AdminAttributionOverview>
  }>(() => ({ gateway: observabilityGateway, scope, value: loading() }))

  const state = !observabilityGateway
    ? unconfigured<AdminAttributionOverview>()
    : scopedState.gateway === observabilityGateway && scopedState.scope === scope
      ? scopedState.value
      : loading<AdminAttributionOverview>()

  useEffect(() => {
    if (!observabilityGateway) return
    let active = true
    void observabilityGateway
      .getAttributionOverview(input)
      .then((result) => {
        if (!active) return
        setScopedState({
          gateway: observabilityGateway,
          scope,
          value: statusFromResult<AdminAttributionOverview>(result),
        })
      })
      .catch(() => {
        if (!active) return
        setScopedState({
          gateway: observabilityGateway,
          scope,
          value: { status: 'error', data: null, error: unavailableError, refreshing: false },
        })
      })
    return () => {
      active = false
    }
  }, [input, observabilityGateway, refreshVersion, scope])

  const refresh = useCallback(() => {
    setScopedState((current) =>
      current.gateway === observabilityGateway && current.scope === scope && current.value.data
        ? { ...current, value: { ...current.value, refreshing: true } }
        : { gateway: observabilityGateway, scope, value: loading() },
    )
    setRefreshVersion((version) => version + 1)
  }, [observabilityGateway, scope])

  return { state, refresh }
}

export function useDataHealth(gateway: AdminGateway) {
  const observabilityGateway = useMemo(() => dataHealthCapability(gateway), [gateway])
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [scopedState, setScopedState] = useState<{
    gateway: DataHealthReader | null
    value: ObservabilityState<AdminDataHealth>
  }>(() => ({ gateway: observabilityGateway, value: loading() }))
  const state = !observabilityGateway
    ? unconfigured<AdminDataHealth>()
    : scopedState.gateway === observabilityGateway
      ? scopedState.value
      : loading<AdminDataHealth>()

  useEffect(() => {
    if (!observabilityGateway) return
    let active = true
    void observabilityGateway
      .getDataHealth()
      .then((result) => {
        if (!active) return
        setScopedState({
          gateway: observabilityGateway,
          value: statusFromResult<AdminDataHealth>(result),
        })
      })
      .catch(() => {
        if (!active) return
        setScopedState({
          gateway: observabilityGateway,
          value: { status: 'error', data: null, error: unavailableError, refreshing: false },
        })
      })
    return () => {
      active = false
    }
  }, [observabilityGateway, refreshVersion])

  const refresh = useCallback(() => {
    setScopedState((current) =>
      current.gateway === observabilityGateway && current.value.data
        ? { ...current, value: { ...current.value, refreshing: true } }
        : { gateway: observabilityGateway, value: loading() },
    )
    setRefreshVersion((version) => version + 1)
  }, [observabilityGateway])

  return { state, refresh }
}

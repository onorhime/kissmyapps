import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AdminDataError, AdminDataResult, AdminGateway, AdminPlatformSettings } from '../api'

export type PlatformSettingsStatus = 'loading' | 'ready' | 'unconfigured' | 'unauthorized' | 'error'

export type PlatformSettingsState = Readonly<{
  status: PlatformSettingsStatus
  data: AdminPlatformSettings | null
  error: AdminDataError | null
  refreshing: boolean
}>

export type PlatformSettingsMutationState = Readonly<{
  status: 'idle' | 'pending' | 'complete' | 'failed'
  error: AdminDataError | null
}>

export type TrackingConfigurationInput = Readonly<{
  baseUrl: string | null
  enabled: boolean
}>

type PlatformSettingsGateway = Required<
  Pick<AdminGateway, 'getPlatformSettings' | 'configureTracking'>
>

const unavailableError: AdminDataError = {
  code: 'temporarily_unavailable',
  message: 'Platform settings are temporarily unavailable.',
  retryable: true,
}

const unconfiguredError: AdminDataError = {
  code: 'contract_unavailable',
  message: 'Platform settings are not available in this deployment.',
  retryable: false,
}

const idleMutation: PlatformSettingsMutationState = { status: 'idle', error: null }

function loading(): PlatformSettingsState {
  return { status: 'loading', data: null, error: null, refreshing: false }
}

function unconfigured(): PlatformSettingsState {
  return { status: 'unconfigured', data: null, error: unconfiguredError, refreshing: false }
}

function stateFromResult(
  result: AdminDataResult<AdminPlatformSettings | null>,
): PlatformSettingsState {
  if (result.status === 'ready' && result.data) {
    return { status: 'ready', data: result.data, error: null, refreshing: false }
  }

  const contractUnavailable =
    result.status === 'unconfigured' ||
    result.error?.code === 'not_configured' ||
    result.error?.code === 'contract_unavailable'

  return {
    status: contractUnavailable
      ? 'unconfigured'
      : result.status === 'unauthorized'
        ? 'unauthorized'
        : 'error',
    data: null,
    error: result.error ?? (contractUnavailable ? unconfiguredError : unavailableError),
    refreshing: false,
  }
}

function capability(gateway: AdminGateway): PlatformSettingsGateway | null {
  return typeof gateway.getPlatformSettings === 'function' &&
    typeof gateway.configureTracking === 'function'
    ? (gateway as PlatformSettingsGateway)
    : null
}

function failedMutation(error: AdminDataError): PlatformSettingsMutationState {
  return { status: 'failed', error }
}

export function usePlatformSettings(gateway: AdminGateway) {
  const settingsGateway = useMemo(() => capability(gateway), [gateway])
  const [reloadVersion, setReloadVersion] = useState(0)
  const requestVersion = useRef(0)
  const [scopedState, setScopedState] = useState<{
    gateway: PlatformSettingsGateway | null
    value: PlatformSettingsState
  }>(() => ({ gateway: settingsGateway, value: loading() }))
  const [scopedMutation, setScopedMutation] = useState<{
    gateway: PlatformSettingsGateway | null
    value: PlatformSettingsMutationState
  }>(() => ({ gateway: settingsGateway, value: idleMutation }))

  const state = !settingsGateway
    ? unconfigured()
    : scopedState.gateway === settingsGateway
      ? scopedState.value
      : loading()
  const mutation = scopedMutation.gateway === settingsGateway ? scopedMutation.value : idleMutation

  useEffect(() => {
    if (!settingsGateway) return

    let active = true
    const version = ++requestVersion.current
    void settingsGateway
      .getPlatformSettings()
      .then((result) => {
        if (!active || requestVersion.current !== version) return
        setScopedState({ gateway: settingsGateway, value: stateFromResult(result) })
      })
      .catch(() => {
        if (!active || requestVersion.current !== version) return
        setScopedState({
          gateway: settingsGateway,
          value: { status: 'error', data: null, error: unavailableError, refreshing: false },
        })
      })

    return () => {
      active = false
    }
  }, [reloadVersion, settingsGateway])

  const retry = useCallback(() => {
    setScopedState((current) => ({
      gateway: settingsGateway,
      value:
        current.gateway === settingsGateway &&
        current.value.status === 'ready' &&
        current.value.data
          ? { ...current.value, refreshing: true, error: null }
          : loading(),
    }))
    setScopedMutation({ gateway: settingsGateway, value: idleMutation })
    setReloadVersion((version) => version + 1)
  }, [settingsGateway])

  const configureTracking = useCallback(
    async (
      input: TrackingConfigurationInput,
    ): Promise<AdminDataResult<AdminPlatformSettings | null>> => {
      if (!settingsGateway) {
        const result: AdminDataResult<AdminPlatformSettings | null> = {
          data: null,
          status: 'unconfigured',
          error: unconfiguredError,
        }
        setScopedMutation({ gateway: settingsGateway, value: failedMutation(unconfiguredError) })
        return result
      }

      const loadedSettings = state.status === 'ready' ? state.data : null
      if (!loadedSettings) {
        const error: AdminDataError = {
          code: 'invalid_state',
          message: 'Refresh platform settings before trying this change again.',
          retryable: false,
        }
        const result: AdminDataResult<AdminPlatformSettings | null> = {
          data: null,
          status: 'error',
          error,
        }
        setScopedMutation({ gateway: settingsGateway, value: failedMutation(error) })
        return result
      }

      const version = ++requestVersion.current
      setScopedMutation({ gateway: settingsGateway, value: { status: 'pending', error: null } })

      let result: AdminDataResult<AdminPlatformSettings | null>
      try {
        result = await settingsGateway.configureTracking({
          ...input,
          expectedUpdatedAt: loadedSettings.tracking.updatedAt,
        })
      } catch {
        result = { data: null, status: 'error', error: unavailableError }
      }

      if (requestVersion.current !== version) return result

      if (result.status === 'ready' && result.data) {
        setScopedState({
          gateway: settingsGateway,
          value: { status: 'ready', data: result.data, error: null, refreshing: false },
        })
        setScopedMutation({
          gateway: settingsGateway,
          value: { status: 'complete', error: null },
        })
        return result
      }

      setScopedMutation({
        gateway: settingsGateway,
        value: failedMutation(result.error ?? unavailableError),
      })
      if (result.error?.code === 'invalid_state' || result.error?.code === 'conflict') {
        setScopedState((current) => ({
          gateway: settingsGateway,
          value:
            current.gateway === settingsGateway &&
            current.value.status === 'ready' &&
            current.value.data
              ? { ...current.value, refreshing: true }
              : current.value,
        }))
        setReloadVersion((current) => current + 1)
      }
      return result
    },
    [settingsGateway, state.data, state.status],
  )

  return { state, mutation, retry, configureTracking }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminGateway,
  hasAdminAffiliateManagementGateway,
  type AdminAffiliateDirectoryInput,
  type AdminAffiliateDirectoryPage,
  type AdminAffiliateDirectoryRecord,
  type AdminAffiliateDirectorySummary,
  type AdminAffiliateStatusChange,
  type AdminAffiliateStatusUpdate,
  type AdminAffiliateTermination,
  type AdminDataError,
  type AdminDataResult,
  type AdminDataStatus,
  type AdminGateway,
} from '../api'

export type AffiliateDirectoryLoadStatus = 'idle' | 'loading' | AdminDataStatus

export type AffiliateDirectoryLoadable<T> = Readonly<{
  status: AffiliateDirectoryLoadStatus
  data: T | null
  error: AdminDataError | null
}>

export type AffiliateMutationState = Readonly<{
  status: 'idle' | 'pending' | 'complete' | 'failed'
  error: AdminDataError | null
}>

const unavailableError: AdminDataError = {
  code: 'temporarily_unavailable',
  message: 'Affiliate management is temporarily unavailable.',
  retryable: true,
}

const unconfiguredError: AdminDataError = {
  code: 'contract_unavailable',
  message: 'Affiliate management is not available in this deployment.',
  retryable: false,
}

const idleMutation: AffiliateMutationState = { status: 'idle', error: null }

function emptyLoadable<T>(): AffiliateDirectoryLoadable<T> {
  return { status: 'idle', data: null, error: null }
}

function loadingLoadable<T>(data: T | null = null): AffiliateDirectoryLoadable<T> {
  return { status: 'loading', data, error: null }
}

function loadableFromResult<T>(result: AdminDataResult<T | null>): AffiliateDirectoryLoadable<T> {
  return { status: result.status, data: result.data, error: result.error }
}

function failedLoadable<T>(error = unavailableError): AffiliateDirectoryLoadable<T> {
  return { status: 'error', data: null, error }
}

type ScopedLoadable<T> = Readonly<{
  gateway: AdminGateway | null
  scope: string
  value: AffiliateDirectoryLoadable<T>
}>

export function useAffiliateDirectory({
  enabled,
  gateway = adminGateway,
  selectedAffiliateId,
}: {
  enabled: boolean
  gateway?: AdminGateway
  selectedAffiliateId: string | null
}) {
  const managementGateway = useMemo(
    () => (hasAdminAffiliateManagementGateway(gateway) ? gateway : null),
    [gateway],
  )
  const [input, setInput] = useState<AdminAffiliateDirectoryInput>({
    sort: 'newest',
    limit: 25,
    offset: 0,
  })
  const [mutation, setMutation] = useState<AffiliateMutationState>(idleMutation)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [detailVersion, setDetailVersion] = useState(0)
  const summaryScope = String(refreshVersion)
  const directoryScope = `${refreshVersion}:${JSON.stringify(input)}`
  const detailScope = `${detailVersion}:${selectedAffiliateId ?? ''}`
  const [scopedSummary, setScopedSummary] = useState<
    ScopedLoadable<AdminAffiliateDirectorySummary>
  >(() => ({ gateway: managementGateway, scope: summaryScope, value: loadingLoadable() }))
  const [scopedDirectory, setScopedDirectory] = useState<
    ScopedLoadable<AdminAffiliateDirectoryPage>
  >(() => ({ gateway: managementGateway, scope: directoryScope, value: loadingLoadable() }))
  const [scopedDetail, setScopedDetail] = useState<ScopedLoadable<AdminAffiliateDirectoryRecord>>(
    () => ({ gateway: managementGateway, scope: detailScope, value: loadingLoadable() }),
  )

  useEffect(() => {
    if (!enabled || !managementGateway) return

    let active = true
    void managementGateway
      .getAffiliateSummary()
      .then((result) => {
        if (!active) return
        setScopedSummary({
          gateway: managementGateway,
          scope: summaryScope,
          value: loadableFromResult(result),
        })
      })
      .catch(() => {
        if (!active) return
        setScopedSummary({
          gateway: managementGateway,
          scope: summaryScope,
          value: failedLoadable(),
        })
      })

    return () => {
      active = false
    }
  }, [enabled, managementGateway, refreshVersion, summaryScope])

  useEffect(() => {
    if (!enabled || !managementGateway) return

    let active = true
    void managementGateway
      .getAffiliateDirectory(input)
      .then((result) => {
        if (!active) return
        setScopedDirectory({
          gateway: managementGateway,
          scope: directoryScope,
          value: loadableFromResult(result),
        })
      })
      .catch(() => {
        if (!active) return
        setScopedDirectory({
          gateway: managementGateway,
          scope: directoryScope,
          value: failedLoadable(),
        })
      })

    return () => {
      active = false
    }
  }, [directoryScope, enabled, input, managementGateway])

  useEffect(() => {
    if (!enabled || !selectedAffiliateId || !managementGateway) return

    let active = true
    void managementGateway
      .getAffiliateDetail(selectedAffiliateId)
      .then((result) => {
        if (!active) return
        setScopedDetail({
          gateway: managementGateway,
          scope: detailScope,
          value: loadableFromResult(result),
        })
      })
      .catch(() => {
        if (!active) return
        setScopedDetail({
          gateway: managementGateway,
          scope: detailScope,
          value: failedLoadable(),
        })
      })

    return () => {
      active = false
    }
  }, [detailScope, enabled, managementGateway, selectedAffiliateId])

  const applyFilters = useCallback(
    (filters: Omit<AdminAffiliateDirectoryInput, 'limit' | 'offset'>) => {
      setInput((current) => ({ ...filters, limit: current.limit ?? 25, offset: 0 }))
    },
    [],
  )

  const goToOffset = useCallback((offset: number) => {
    setInput((current) => ({ ...current, offset: Math.max(0, offset) }))
  }, [])

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1)
    if (selectedAffiliateId) setDetailVersion((version) => version + 1)
  }, [selectedAffiliateId])

  const runMutation = useCallback(
    async (
      action: () => Promise<AdminDataResult<AdminAffiliateStatusChange | null>>,
    ): Promise<boolean> => {
      setMutation({ status: 'pending', error: null })
      let result: AdminDataResult<AdminAffiliateStatusChange | null>
      try {
        result = await action()
      } catch {
        result = { data: null, status: 'error', error: unavailableError }
      }
      if (result.status === 'ready' && result.data) {
        setMutation({ status: 'complete', error: null })
        setRefreshVersion((version) => version + 1)
        setDetailVersion((version) => version + 1)
        return true
      }
      setMutation({ status: 'failed', error: result.error ?? unavailableError })
      return false
    },
    [],
  )

  const setAffiliateStatus = useCallback(
    async (statusUpdate: AdminAffiliateStatusUpdate) => {
      if (!managementGateway) {
        setMutation({ status: 'failed', error: unconfiguredError })
        return false
      }
      return runMutation(() => managementGateway.setAffiliateStatus(statusUpdate))
    },
    [managementGateway, runMutation],
  )

  const terminateAffiliate = useCallback(
    async (termination: AdminAffiliateTermination) => {
      if (!managementGateway) {
        setMutation({ status: 'failed', error: unconfiguredError })
        return false
      }
      return runMutation(() => managementGateway.terminateAffiliate(termination))
    },
    [managementGateway, runMutation],
  )

  const clearMutation = useCallback(() => setMutation(idleMutation), [])

  const unavailableLoadable = {
    status: 'unconfigured',
    data: null,
    error: unconfiguredError,
  } as const
  const resolvedSummary = !enabled
    ? emptyLoadable<AdminAffiliateDirectorySummary>()
    : !managementGateway
      ? unavailableLoadable
      : scopedSummary.gateway === managementGateway && scopedSummary.scope === summaryScope
        ? scopedSummary.value
        : loadingLoadable<AdminAffiliateDirectorySummary>()
  const resolvedDirectory = !enabled
    ? emptyLoadable<AdminAffiliateDirectoryPage>()
    : !managementGateway
      ? unavailableLoadable
      : scopedDirectory.gateway === managementGateway && scopedDirectory.scope === directoryScope
        ? scopedDirectory.value
        : loadingLoadable<AdminAffiliateDirectoryPage>()
  const resolvedDetail =
    !enabled || !selectedAffiliateId
      ? emptyLoadable<AdminAffiliateDirectoryRecord>()
      : !managementGateway
        ? unavailableLoadable
        : scopedDetail.gateway === managementGateway && scopedDetail.scope === detailScope
          ? scopedDetail.value
          : loadingLoadable<AdminAffiliateDirectoryRecord>()

  return {
    input,
    summary: resolvedSummary,
    directory: resolvedDirectory,
    detail: resolvedDetail,
    mutation,
    applyFilters,
    goToOffset,
    refresh,
    setAffiliateStatus,
    terminateAffiliate,
    clearMutation,
  }
}

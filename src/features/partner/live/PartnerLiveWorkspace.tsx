import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createPartnerDataGateway,
  type PartnerDataResult,
  type PartnerLink,
  type PartnerLinkCreate,
  type PartnerLinkStatus,
  type PartnerLinkUpdate,
  type PartnerPayoutDetail,
  type PartnerProfile,
  type PartnerProfileUpdate,
  type PartnerSettingsUpdate,
} from '../api'
import { PartnerLiveWorkspaceContext } from './context'
import {
  createLoadingPartnerLiveSnapshot,
  createPartnerLiveSnapshot,
  createUnauthenticatedPartnerLiveSnapshot,
  createUnconfiguredPartnerLiveSnapshot,
  loadPartnerLiveProducts,
  loadPartnerLiveWorkspace,
  unavailablePartnerDataResult,
} from './loader'
import type {
  PartnerLiveMutationOperation,
  PartnerLiveMutationState,
  PartnerLiveWorkspaceActions,
  PartnerLiveWorkspaceProviderProps,
  PartnerLiveWorkspaceSnapshot,
  PartnerLiveWorkspaceValue,
  PartnerPayoutDetailResult,
} from './types'

const idleMutation: PartnerLiveMutationState = {
  status: 'idle',
  operation: null,
  error: null,
}

function queryKey(reporting: PartnerLiveWorkspaceProviderProps['reporting']): string {
  return [
    reporting.startsOn,
    reporting.endsOn,
    reporting.timezone,
    reporting.sourceId ?? '',
    reporting.campaignId ?? '',
    reporting.funnelId ?? '',
    reporting.countryCode ?? '',
    reporting.subId ?? '',
    reporting.grain,
    reporting.breakdown,
  ].join('\u001f')
}

function isKnownCollection(status: string): boolean {
  return status === 'ready' || status === 'empty'
}

function resolveProductId(
  products: PartnerLiveWorkspaceSnapshot['resources']['products']['data'],
  requestedProductId: string | null,
): string | null {
  if (requestedProductId && products.some((product) => product.id === requestedProductId)) {
    return requestedProductId
  }
  const ordered = [...products].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
  return ordered.find((product) => product.status === 'active')?.id ?? ordered[0]?.id ?? null
}

function mergeCreatedLink(
  snapshot: PartnerLiveWorkspaceSnapshot,
  link: PartnerLink,
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  const current = snapshot.resources.links
  if (!isKnownCollection(current.status)) return snapshot
  if (selectedProductId !== null && link.productId !== selectedProductId) return snapshot
  const links = [link, ...current.data.filter((candidate) => candidate.id !== link.id)]
  return createPartnerLiveSnapshot(
    { ...snapshot.resources, links: { data: links, status: 'ready', error: null } },
    selectedProductId,
  )
}

function mergeUpdatedLink(
  snapshot: PartnerLiveWorkspaceSnapshot,
  link: PartnerLink,
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  const current = snapshot.resources.links
  if (!isKnownCollection(current.status)) return snapshot
  if (!current.data.some((candidate) => candidate.id === link.id)) return snapshot
  const links = current.data.map((candidate) => (candidate.id === link.id ? link : candidate))
  return createPartnerLiveSnapshot(
    { ...snapshot.resources, links: { data: links, status: 'ready', error: null } },
    selectedProductId,
  )
}

function mergeProfile(
  snapshot: PartnerLiveWorkspaceSnapshot,
  profile: PartnerProfile,
  selectedProductId: string | null,
): PartnerLiveWorkspaceSnapshot {
  return createPartnerLiveSnapshot(
    {
      ...snapshot.resources,
      profile: { data: profile, status: 'ready', error: null },
    },
    selectedProductId,
  )
}

export function PartnerLiveWorkspaceProvider({
  children,
  client,
  sessionUserId,
  reporting,
  initialProductId = null,
  gateway: suppliedGateway,
}: PartnerLiveWorkspaceProviderProps) {
  const gateway = useMemo(
    () =>
      suppliedGateway ??
      (client === undefined ? createPartnerDataGateway() : createPartnerDataGateway(client)),
    [client, suppliedGateway],
  )
  const selectionScope = `${sessionUserId ?? 'anonymous'}\u001d${initialProductId ?? 'none'}`
  const [selection, setSelection] = useState(() => ({
    scope: selectionScope,
    productId: initialProductId,
  }))
  const selectedProductId =
    selection.scope === selectionScope ? selection.productId : initialProductId
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [scopedMutation, setScopedMutation] = useState(() => ({
    scope: selectionScope,
    value: idleMutation,
  }))
  const reportingKey = queryKey(reporting)
  const requestKey = `${sessionUserId ?? 'anonymous'}\u001e${selectedProductId ?? 'all'}\u001e${reportingKey}`
  const [loaded, setLoaded] = useState<{
    gateway: typeof gateway | null
    requestKey: string | null
    snapshot: PartnerLiveWorkspaceSnapshot
  }>(() => ({
    gateway: null,
    requestKey: null,
    snapshot: createLoadingPartnerLiveSnapshot(initialProductId),
  }))
  const hasConnection = client !== null || suppliedGateway !== undefined
  const loadedMatchesRequest = loaded.gateway === gateway && loaded.requestKey === requestKey
  const snapshot = useMemo(() => {
    if (sessionUserId === null) {
      return createUnauthenticatedPartnerLiveSnapshot(selectedProductId)
    }
    if (!hasConnection) return createUnconfiguredPartnerLiveSnapshot(selectedProductId)
    if (loadedMatchesRequest) return loaded.snapshot
    return createLoadingPartnerLiveSnapshot(selectedProductId)
  }, [hasConnection, loaded.snapshot, loadedMatchesRequest, selectedProductId, sessionUserId])
  const mutation = scopedMutation.scope === selectionScope ? scopedMutation.value : idleMutation

  useEffect(() => {
    if (sessionUserId === null || !hasConnection) return
    let active = true

    void (async () => {
      const products = await loadPartnerLiveProducts(gateway)
      if (!active) return
      if (isKnownCollection(products.status)) {
        const resolvedProductId = resolveProductId(products.data, selectedProductId)
        if (resolvedProductId !== selectedProductId) {
          setSelection({ scope: selectionScope, productId: resolvedProductId })
          setIsRefreshing(false)
          return
        }
      }

      const nextSnapshot = await loadPartnerLiveWorkspace(
        gateway,
        {
          productId: selectedProductId,
          reporting: {
            startsOn: reporting.startsOn,
            endsOn: reporting.endsOn,
            timezone: reporting.timezone,
            sourceId: reporting.sourceId,
            campaignId: reporting.campaignId,
            funnelId: reporting.funnelId,
            countryCode: reporting.countryCode,
            subId: reporting.subId,
            grain: reporting.grain,
            breakdown: reporting.breakdown,
          },
        },
        products,
      )
      if (!active) return
      setLoaded({ gateway, requestKey, snapshot: nextSnapshot })
      setIsRefreshing(false)
    })()

    return () => {
      active = false
    }
  }, [
    gateway,
    hasConnection,
    refreshVersion,
    reporting.breakdown,
    reporting.campaignId,
    reporting.countryCode,
    reporting.endsOn,
    reporting.funnelId,
    reporting.grain,
    reportingKey,
    reporting.sourceId,
    reporting.startsOn,
    reporting.subId,
    reporting.timezone,
    requestKey,
    selectedProductId,
    selectionScope,
    sessionUserId,
  ])

  const refresh = useCallback(() => {
    setIsRefreshing(true)
    setRefreshVersion((version) => version + 1)
  }, [])

  const selectProduct = useCallback(
    (productId: string | null) => setSelection({ scope: selectionScope, productId }),
    [selectionScope],
  )

  const updateSnapshot = useCallback(
    (update: (current: PartnerLiveWorkspaceSnapshot) => PartnerLiveWorkspaceSnapshot) => {
      setLoaded((current) => {
        if (current.gateway !== gateway || current.requestKey !== requestKey) return current
        return { ...current, snapshot: update(current.snapshot) }
      })
    },
    [gateway, requestKey],
  )

  const runMutation = useCallback(
    async <T,>(
      operation: PartnerLiveMutationOperation,
      fallback: T,
      request: () => Promise<PartnerDataResult<T>>,
    ): Promise<PartnerDataResult<T>> => {
      if (sessionUserId === null) {
        const result: PartnerDataResult<T> = {
          data: fallback,
          status: 'error',
          error: {
            code: 'not_authenticated',
            message: 'Sign in to access partner data.',
            retryable: false,
          },
        }
        setScopedMutation({
          scope: selectionScope,
          value: { status: 'failed', operation, error: result.error },
        })
        return result
      }

      setScopedMutation({
        scope: selectionScope,
        value: { status: 'pending', operation, error: null },
      })
      let result: PartnerDataResult<T>
      try {
        result = await request()
      } catch {
        result = unavailablePartnerDataResult(fallback)
      }
      setScopedMutation({
        scope: selectionScope,
        value: {
          status:
            result.status === 'error' || result.status === 'unconfigured' ? 'failed' : 'complete',
          operation,
          error: result.error,
        },
      })
      return result
    },
    [selectionScope, sessionUserId],
  )

  const createLink = useCallback(
    async (input: PartnerLinkCreate) => {
      const result = await runMutation('create-link', null, () => gateway.createPartnerLink(input))
      if (result.status === 'ready' && result.data) {
        updateSnapshot((current) => mergeCreatedLink(current, result.data!, selectedProductId))
      }
      return result
    },
    [gateway, runMutation, selectedProductId, updateSnapshot],
  )

  const updateLink = useCallback(
    async (linkId: string, patch: PartnerLinkUpdate) => {
      const result = await runMutation('update-link', null, () =>
        gateway.updatePartnerLink(linkId, patch),
      )
      if (result.status === 'ready' && result.data) {
        updateSnapshot((current) => mergeUpdatedLink(current, result.data!, selectedProductId))
      }
      return result
    },
    [gateway, runMutation, selectedProductId, updateSnapshot],
  )

  const setLinkStatus = useCallback(
    async (linkId: string, status: PartnerLinkStatus) => {
      const result = await runMutation('set-link-status', null, () =>
        gateway.setPartnerLinkStatus(linkId, status),
      )
      if (result.status === 'ready' && result.data) {
        updateSnapshot((current) => mergeUpdatedLink(current, result.data!, selectedProductId))
      }
      return result
    },
    [gateway, runMutation, selectedProductId, updateSnapshot],
  )

  const updateProfile = useCallback(
    async (profile: PartnerProfileUpdate) => {
      const result = await runMutation('update-profile', null, () =>
        gateway.updatePartnerProfile(profile),
      )
      if (result.status === 'ready' && result.data) {
        const timezoneChanged = snapshot.resources.profile.data?.timezone !== result.data.timezone
        updateSnapshot((current) => mergeProfile(current, result.data!, selectedProductId))
        if (timezoneChanged) refresh()
      }
      return result
    },
    [
      gateway,
      refresh,
      runMutation,
      selectedProductId,
      snapshot.resources.profile.data,
      updateSnapshot,
    ],
  )

  const updateSettings = useCallback(
    async (settings: PartnerSettingsUpdate) => {
      const result = await runMutation('update-settings', null, () =>
        gateway.updatePartnerSettings(settings),
      )
      if (result.status === 'ready' && result.data) {
        updateSnapshot((current) => mergeProfile(current, result.data!, selectedProductId))
      }
      return result
    },
    [gateway, runMutation, selectedProductId, updateSnapshot],
  )

  const loadPayoutDetail = useCallback(
    async (payoutId: string): Promise<PartnerPayoutDetailResult> => {
      const result = await runMutation<PartnerPayoutDetail | null>('load-payout-detail', null, () =>
        gateway.getPayoutDetail(payoutId),
      )
      return {
        detail: result.data,
        status:
          result.status === 'error' && result.error?.retryable ? 'unavailable' : result.status,
        error: result.error,
      }
    },
    [gateway, runMutation],
  )

  const actions = useMemo<PartnerLiveWorkspaceActions>(
    () => ({
      refresh,
      selectProduct,
      createLink,
      updateLink,
      setLinkStatus,
      updateProfile,
      updateSettings,
      loadPayoutDetail,
    }),
    [
      createLink,
      loadPayoutDetail,
      refresh,
      selectProduct,
      setLinkStatus,
      updateLink,
      updateProfile,
      updateSettings,
    ],
  )

  const value = useMemo<PartnerLiveWorkspaceValue>(
    () => ({
      snapshot,
      selectedProductId,
      isRefreshing: loadedMatchesRequest && isRefreshing,
      mutation,
      actions,
    }),
    [actions, isRefreshing, loadedMatchesRequest, mutation, selectedProductId, snapshot],
  )

  return (
    <PartnerLiveWorkspaceContext.Provider value={value}>
      {children}
    </PartnerLiveWorkspaceContext.Provider>
  )
}

import { useCallback, useEffect, useState } from 'react'
import {
  adminGateway,
  type AdminContext,
  type AdminDataError,
  type AdminDataResult,
  type AdminGateway,
  type AdminProduct,
  type AdminProductCreate,
} from './api'

export type AdminWorkspaceStatus =
  'loading' | 'ready' | 'empty' | 'unauthenticated' | 'unauthorized' | 'unconfigured' | 'error'

export type AdminMutationState = Readonly<{
  status: 'idle' | 'pending' | 'complete' | 'failed'
  error: AdminDataError | null
}>

export type AdminWorkspaceState = Readonly<{
  status: AdminWorkspaceStatus
  context: AdminContext | null
  products: readonly AdminProduct[]
  error: AdminDataError | null
}>

const idleMutation: AdminMutationState = { status: 'idle', error: null }

function initialState(sessionUserId: string | null): AdminWorkspaceState {
  return sessionUserId
    ? { status: 'loading', context: null, products: [], error: null }
    : { status: 'unauthenticated', context: null, products: [], error: null }
}

function workspaceStatus(status: string): AdminWorkspaceStatus {
  if (status === 'unauthorized') return 'unauthorized'
  if (status === 'unconfigured') return 'unconfigured'
  return 'error'
}

function unavailableProductResult(): AdminDataResult<AdminProduct | null> {
  return {
    data: null,
    status: 'error',
    error: {
      code: 'temporarily_unavailable',
      message: 'Admin data is temporarily unavailable.',
      retryable: true,
    },
  }
}

function orderedProducts(products: readonly AdminProduct[]): AdminProduct[] {
  return [...products].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}

export function useAdminWorkspace({
  sessionUserId,
  gateway = adminGateway,
}: {
  sessionUserId: string | null
  gateway?: AdminGateway
}) {
  const scope = sessionUserId ?? 'anonymous'
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [scopedState, setScopedState] = useState<{
    scope: string
    value: AdminWorkspaceState
  }>(() => ({ scope, value: initialState(sessionUserId) }))
  const [scopedMutation, setScopedMutation] = useState<{
    scope: string
    value: AdminMutationState
  }>(() => ({ scope, value: idleMutation }))
  const state = scopedState.scope === scope ? scopedState.value : initialState(sessionUserId)
  const mutation = scopedMutation.scope === scope ? scopedMutation.value : idleMutation

  useEffect(() => {
    if (!sessionUserId) return

    let active = true

    void (async () => {
      const contextResult = await gateway.getAdminContext()
      if (!active) return
      if (contextResult.status !== 'ready' || !contextResult.data) {
        setScopedState({
          scope,
          value: {
            status: workspaceStatus(contextResult.status),
            context: null,
            products: [],
            error: contextResult.error,
          },
        })
        return
      }

      const productsResult = await gateway.getProducts()
      if (!active) return
      if (productsResult.status === 'ready' || productsResult.status === 'empty') {
        setScopedState({
          scope,
          value: {
            status: productsResult.data.length ? 'ready' : 'empty',
            context: contextResult.data,
            products: orderedProducts(productsResult.data),
            error: null,
          },
        })
        return
      }

      setScopedState({
        scope,
        value: {
          status: workspaceStatus(productsResult.status),
          context: contextResult.data,
          products: [],
          error: productsResult.error,
        },
      })
    })()

    return () => {
      active = false
    }
  }, [gateway, refreshVersion, scope, sessionUserId])

  const retry = useCallback(() => {
    setScopedState({ scope, value: initialState(sessionUserId) })
    setScopedMutation({ scope, value: idleMutation })
    setRefreshVersion((version) => version + 1)
  }, [scope, sessionUserId])

  const createProduct = useCallback(
    async (input: AdminProductCreate): Promise<AdminDataResult<AdminProduct | null>> => {
      if (!sessionUserId || !state.context) {
        const denied: AdminDataResult<AdminProduct | null> = {
          data: null,
          status: 'unauthorized',
          error: {
            code: sessionUserId ? 'not_authorized' : 'not_authenticated',
            message: sessionUserId
              ? 'This account does not have permission to create products.'
              : 'Sign in with an authorized administrator account.',
            retryable: false,
          },
        }
        setScopedMutation({ scope, value: { status: 'failed', error: denied.error } })
        return denied
      }

      setScopedMutation({ scope, value: { status: 'pending', error: null } })
      let creation: AdminDataResult<AdminProduct | null>
      try {
        creation = await gateway.createProduct(input)
      } catch {
        creation = unavailableProductResult()
      }

      if (creation.status === 'ready' && creation.data) {
        setScopedState((current) => {
          if (current.scope !== scope) return current
          const products = orderedProducts([
            creation.data!,
            ...current.value.products.filter((product) => product.id !== creation.data!.id),
          ])
          return {
            scope,
            value: { ...current.value, products, status: 'ready', error: null },
          }
        })
        setScopedMutation({ scope, value: { status: 'complete', error: null } })
      } else {
        setScopedMutation({ scope, value: { status: 'failed', error: creation.error } })
      }
      return creation
    },
    [gateway, scope, sessionUserId, state.context],
  )

  const replaceProduct = useCallback(
    (product: AdminProduct) => {
      setScopedState((current) => {
        if (current.scope !== scope) return current
        return {
          scope,
          value: {
            ...current.value,
            products: orderedProducts([
              product,
              ...current.value.products.filter((candidate) => candidate.id !== product.id),
            ]),
          },
        }
      })
    },
    [scope],
  )

  return { state, mutation, retry, createProduct, replaceProduct }
}

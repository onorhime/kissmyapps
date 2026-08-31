import { useContext } from 'react'
import { PartnerLiveWorkspaceContext } from './context'
import type { PartnerLiveWorkspaceValue } from './types'

export function usePartnerLiveWorkspace(): PartnerLiveWorkspaceValue {
  const value = useContext(PartnerLiveWorkspaceContext)
  if (!value) {
    throw new Error('usePartnerLiveWorkspace must be used inside PartnerLiveWorkspaceProvider.')
  }
  return value
}

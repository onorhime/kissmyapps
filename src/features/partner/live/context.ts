import { createContext } from 'react'
import type { PartnerLiveWorkspaceValue } from './types'

export const PartnerLiveWorkspaceContext = createContext<PartnerLiveWorkspaceValue | null>(null)

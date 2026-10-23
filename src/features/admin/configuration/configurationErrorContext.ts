import { createContext } from 'react'

export const ConfigurationErrorContext = createContext({
  error: null as string | null,
  clear: () => {},
})

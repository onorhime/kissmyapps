import type { AdminDataResult } from '../api'

export type ConfigurationActionRunner = <T>(
  key: string,
  operation: () => Promise<AdminDataResult<T>>,
  successMessage: string,
) => Promise<boolean>

// The parts of react-native this package uses, so it can be checked without installing
// React Native. Checked against react-native 0.70 and 0.76's own types.
declare module 'react-native' {
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension'
  export const AppState: {
    currentState: AppStateStatus | null
    addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void }
  }
  export const Dimensions: {
    get(dimension: 'screen' | 'window'): { width: number; height: number; scale: number }
  }
  export const Platform: {
    OS: 'ios' | 'android' | 'web' | 'windows' | 'macos'
    Version: number | string
    constants: object
    isPad?: boolean
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const NativeModules: Record<string, any>
}

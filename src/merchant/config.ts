/** Where apps send events, and where the web SDK is served. Overridable for local stacks. */
export const ANALYTICS_ENDPOINT = (
  import.meta.env.VITE_ANALYTICS_ENDPOINT?.trim() || 'https://events.kissmyapps.dev'
).replace(/\/+$/, '')

export const SDK_URL =
  import.meta.env.VITE_ANALYTICS_SDK_URL?.trim() || 'https://merchant.kissmyapps.dev/sdk/kma.js'

/**
 * Where the app SDKs are published (see integrations/analytics-mobile/README.md). The iOS
 * and Android SDKs share one public repository: Swift Package Manager reads it directly and
 * JitPack builds the Android library from its tags. React Native comes from npm and
 * Flutter from pub.dev.
 */
export const MOBILE_SDK = {
  version: '1.0.0',
  repository:
    import.meta.env.VITE_MOBILE_SDK_REPOSITORY?.trim() ||
    'https://github.com/onorhime/kissmyapps-mobile',
  npmPackage: '@kissmyappss/react-native',
  pubPackage: 'kissmyapps',
}

/** JitPack's coordinates for a single-library repository: com.github.<owner>:<repository>. */
export function jitpackArtifact(repository = MOBILE_SDK.repository, version = MOBILE_SDK.version) {
  const [owner = 'owner', name = 'repository'] = new URL(repository).pathname
    .split('/')
    .filter(Boolean)
  return `com.github.${owner}:${name}:${version}`
}

/** Where apps send events, and where the web SDK is served. Overridable for local stacks. */
export const ANALYTICS_ENDPOINT = (
  import.meta.env.VITE_ANALYTICS_ENDPOINT?.trim() || 'https://events.kissmyapps.dev'
).replace(/\/+$/, '')

export const SDK_URL =
  import.meta.env.VITE_ANALYTICS_SDK_URL?.trim() || 'https://merchant.kissmyapps.dev/sdk/kma.js'

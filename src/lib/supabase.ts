import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

function isPlaceholder(value: string | undefined) {
  return !value || value.includes('your-project-ref') || value.startsWith('replace-with-')
}

function isSupportedUrl(value: string | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

const configurationIssue = (() => {
  if (isPlaceholder(rawSupabaseUrl) || isPlaceholder(rawSupabaseAnonKey)) {
    return 'Partner sign-in is not configured yet. Add the Supabase project URL and publishable key to the app environment.'
  }
  if (!isSupportedUrl(rawSupabaseUrl)) {
    return 'Partner sign-in is unavailable because the configured Supabase URL is invalid.'
  }
  return null
})()

export const hasSupabaseConfig = configurationIssue === null

export const supabase: SupabaseClient | null = hasSupabaseConfig
  ? createClient(rawSupabaseUrl!, rawSupabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Stripe's OAuth code belongs to merchant-connect, not Supabase Auth.
        detectSessionInUrl: window.location.pathname !== '/merchant/callback',
        flowType: 'pkce',
      },
    })
  : null

export function getSupabaseConfigurationIssue() {
  return configurationIssue
}

export function requireSupabaseClient(): SupabaseClient {
  if (!supabase) {
    throw new Error(configurationIssue ?? 'Partner sign-in is unavailable.')
  }
  return supabase
}

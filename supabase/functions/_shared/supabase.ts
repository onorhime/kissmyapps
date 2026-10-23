import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv, serviceRoleKey } from "./env.ts";

export function serviceClient(requestTimeoutMs?: number): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "kissmyapps-edge-functions/1.0" },
      ...(requestTimeoutMs
        ? {
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const timeout = AbortSignal.timeout(requestTimeoutMs);
            return fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, timeout])
                : timeout,
            });
          },
        }
        : {}),
    },
  });
}

export function authenticatedClient(authorization: string): SupabaseClient {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_ANON_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: authorization,
          "X-Client-Info": "kissmyapps-edge-functions/1.0",
        },
      },
    },
  );
}

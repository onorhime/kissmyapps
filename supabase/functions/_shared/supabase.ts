import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv, serviceRoleKey } from "./env.ts";

export function serviceClient(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), serviceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "kissmyapps-edge-functions/1.0" },
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

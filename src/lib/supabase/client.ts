import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readSupabasePublicConfig } from "./config";
import type { Database } from "./database.types";

let browserClient: SupabaseClient<Database> | null = null;

export function isSupabaseConfigured() {
  return readSupabasePublicConfig() !== null;
}

export function getSupabaseClient(): SupabaseClient<Database> {
  if (browserClient) return browserClient;

  const config = readSupabasePublicConfig();
  if (!config) {
    throw new Error(
      "Supabase is not configured. Copy .env.example to .env.local and add the public project values.",
    );
  }

  browserClient = createClient<Database>(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });

  return browserClient;
}

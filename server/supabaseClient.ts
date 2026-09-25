import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  const url = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url) {
    throw new Error("Missing SUPABASE_URL. Set it in .env using .env.example as a guide.");
  }
  if (!secretKey) {
    throw new Error("Missing SUPABASE_SECRET_KEY. Set it in .env using .env.example as a guide.");
  }

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

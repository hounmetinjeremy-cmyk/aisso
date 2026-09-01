import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://uvkpqgihomwgszhrapda.supabase.co';

/**
 * Client Supabase avec la clé service_role : contourne toutes les policies
 * RLS. Serveur uniquement — ne jamais importer depuis un fichier .client.ts
 * ou exposer cette clé au navigateur.
 */
export function getSupabaseAdmin(serviceRoleKey: string): SupabaseClient {
  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

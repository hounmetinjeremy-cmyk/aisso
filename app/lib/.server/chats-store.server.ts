import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

/**
 * Toutes les routes api.chats.* et api.snapshots.* partagent ce garde d'authentification :
 * jeton Firebase vérifié -> client Supabase service_role (contourne RLS, jamais exposé
 * au navigateur — voir supabase-admin.server.ts). Centralisé ici pour éviter de
 * dupliquer cette logique dans chaque route.
 */
export async function requireAuthedSupabase(
  request: Request,
  context: { cloudflare?: { env: Env } },
): Promise<{ userId: string; supabase: SupabaseClient } | Response> {
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const userId = await verifyFirebaseIdToken(idToken);

  if (!userId) {
    return Response.json({ error: 'Non authentifié' }, { status: 401 });
  }

  const env = context.cloudflare?.env as Env | undefined;

  if (!env?.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquant côté serveur.' }, { status: 500 });
  }

  return { userId, supabase: getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY) };
}

export interface ChatRow {
  id: string;
  user_id: string;
  url_id: string | null;
  description: string | null;
  messages: unknown[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Forme envoyée/reçue côté client — voir ChatHistoryItem dans useChatHistory.ts. */
export interface ChatHistoryItemDTO {
  id: string;
  urlId?: string;
  description?: string;
  messages: unknown[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export function rowToDto(row: ChatRow): ChatHistoryItemDTO {
  return {
    id: row.id,
    urlId: row.url_id ?? undefined,
    description: row.description ?? undefined,
    messages: row.messages ?? [],
    timestamp: row.updated_at,
    metadata: row.metadata ?? undefined,
  };
}

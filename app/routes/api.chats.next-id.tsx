import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAuthedSupabase } from '~/lib/.server/chats-store.server';

/**
 * Reproduit le schéma d'id de l'ancienne implémentation IndexedDB (db.ts:getNextId) :
 * max(id numérique existant) + 1, propre à cet utilisateur. Les ids restent de simples
 * entiers en texte, pas des UUID, pour ne rien changer au format déjà utilisé dans les
 * URLs /chat/:id existantes.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const { data, error } = await supabase.from('chats').select('id').eq('user_id', userId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const highestId = (data ?? []).reduce((max, row) => {
    const n = Number(row.id);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  return Response.json({ id: String(highestId + 1) });
}

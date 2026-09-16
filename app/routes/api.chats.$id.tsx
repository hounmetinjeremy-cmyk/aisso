import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAuthedSupabase, rowToDto, type ChatRow } from '~/lib/.server/chats-store.server';

/** GET /api/chats/:id — cherche par id exact, sinon par url_id (reproduit db.ts:getMessages). */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const id = params.id;

  if (!id) {
    return Response.json({ error: 'id manquant' }, { status: 400 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const { data: byId, error: byIdError } = await supabase
    .from('chats')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();

  if (byIdError) {
    return Response.json({ error: byIdError.message }, { status: 500 });
  }

  if (byId) {
    return Response.json({ chat: rowToDto(byId as ChatRow) });
  }

  const { data: byUrlId, error: byUrlIdError } = await supabase
    .from('chats')
    .select('*')
    .eq('user_id', userId)
    .eq('url_id', id)
    .maybeSingle();

  if (byUrlIdError) {
    return Response.json({ error: byUrlIdError.message }, { status: 500 });
  }

  return Response.json({ chat: byUrlId ? rowToDto(byUrlId as ChatRow) : null });
}

interface UpsertBody {
  messages: unknown[];
  urlId?: string;
  description?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

const isUrlIdCollision = (error: { code?: string; message?: string } | null) =>
  !!error && error.code === '23505' && !!error.message?.includes('chats_user_url_id_key');

/**
 * api.chats.url-id.$candidate.tsx ne fait que suggérer un slug libre (check-then-act) :
 * deux nouvelles conversations démarrées en même temps avec le même premier message
 * peuvent recevoir le même candidat. On retente ici avec un suffixe -2, -3... sur la
 * VRAIE contrainte d'unicité (chats_user_url_id_key) au lieu de laisser remonter
 * l'erreur Postgres brute jusqu'à l'utilisateur.
 */
async function upsertChatWithUrlIdRetry(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  id: string,
  body: UpsertBody,
) {
  const baseUrlId = body.urlId ?? null;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidateUrlId = baseUrlId && attempt > 1 ? `${baseUrlId}-${attempt}` : baseUrlId;

    const { error } = await supabase.from('chats').upsert(
      {
        id,
        user_id: userId,
        url_id: candidateUrlId,
        description: body.description ?? null,
        messages: body.messages,
        metadata: body.metadata ?? null,
        updated_at: body.timestamp ?? new Date().toISOString(),
      },
      { onConflict: 'user_id,id' },
    );

    if (!error) {
      return null;
    }

    if (!isUrlIdCollision(error) || !baseUrlId || attempt === maxAttempts) {
      return error;
    }
  }

  return null;
}

/** PUT crée/met à jour la conversation ; DELETE la supprime (avec son snapshot). */
export async function action({ request, context, params }: ActionFunctionArgs) {
  const id = params.id;

  if (!id) {
    return Response.json({ error: 'id manquant' }, { status: 400 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  if (request.method === 'DELETE') {
    const [{ error: snapshotError }, { error: chatError }] = await Promise.all([
      supabase.from('snapshots').delete().eq('user_id', userId).eq('chat_id', id),
      supabase.from('chats').delete().eq('user_id', userId).eq('id', id),
    ]);

    const error = chatError || snapshotError;

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.json<UpsertBody>();

    if (body.timestamp && Number.isNaN(Date.parse(body.timestamp))) {
      return Response.json({ error: 'Invalid timestamp' }, { status: 400 });
    }

    const error = await upsertChatWithUrlIdRetry(supabase, userId, id, body);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true });
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

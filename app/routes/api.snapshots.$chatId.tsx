import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAuthedSupabase } from '~/lib/.server/chats-store.server';

/** GET /api/snapshots/:chatId — snapshot de fichiers associé à une conversation (restauration sans re-générer). */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const chatId = params.chatId;

  if (!chatId) {
    return Response.json({ error: 'chatId manquant' }, { status: 400 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const { data, error } = await supabase
    .from('snapshots')
    .select('snapshot')
    .eq('user_id', userId)
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ snapshot: data?.snapshot ?? null });
}

/** PUT enregistre/remplace le snapshot ; DELETE le supprime. */
export async function action({ request, context, params }: ActionFunctionArgs) {
  const chatId = params.chatId;

  if (!chatId) {
    return Response.json({ error: 'chatId manquant' }, { status: 400 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  if (request.method === 'DELETE') {
    const { error } = await supabase.from('snapshots').delete().eq('user_id', userId).eq('chat_id', chatId);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.json<{ snapshot: unknown }>();

    const { error } = await supabase.from('snapshots').upsert(
      {
        user_id: userId,
        chat_id: chatId,
        snapshot: body.snapshot,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,chat_id' },
    );

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true });
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

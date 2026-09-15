import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAuthedSupabase, rowToDto, type ChatRow } from '~/lib/.server/chats-store.server';

/** Liste toutes les conversations de l'utilisateur (historique complet, y compris les messages). */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const { data, error } = await supabase
    .from('chats')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ chats: (data as ChatRow[]).map(rowToDto) });
}

/** DELETE /api/chats : supprime toutes les conversations (et leurs snapshots) de l'utilisateur. */
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'DELETE') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const [{ error: snapshotsError }, { error: chatsError }] = await Promise.all([
    supabase.from('snapshots').delete().eq('user_id', userId),
    supabase.from('chats').delete().eq('user_id', userId),
  ]);

  const error = chatsError || snapshotsError;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}

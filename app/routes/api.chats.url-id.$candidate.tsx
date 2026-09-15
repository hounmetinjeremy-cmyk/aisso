import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireAuthedSupabase } from '~/lib/.server/chats-store.server';

/** Reproduit db.ts:getUrlId — ajoute un suffixe -2, -3... si l'id candidat est déjà pris comme urlId. */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const candidate = params.candidate;

  if (!candidate) {
    return Response.json({ error: 'candidate manquant' }, { status: 400 });
  }

  const auth = await requireAuthedSupabase(request, context);

  if (auth instanceof Response) {
    return auth;
  }

  const { userId, supabase } = auth;

  const { data, error } = await supabase.from('chats').select('url_id').eq('user_id', userId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const taken = new Set((data ?? []).map((row) => row.url_id).filter(Boolean) as string[]);

  if (!taken.has(candidate)) {
    return Response.json({ urlId: candidate });
  }

  let i = 2;

  while (taken.has(`${candidate}-${i}`)) {
    i++;
  }

  return Response.json({ urlId: `${candidate}-${i}` });
}

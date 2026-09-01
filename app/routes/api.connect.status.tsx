import type { LoaderFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

/**
 * Indique quels comptes (GitHub/Vercel) sont déjà connectés pour l'utilisateur
 * courant, sans jamais renvoyer les jetons eux-mêmes au client.
 */
export const loader: LoaderFunction = async ({ request, context }) => {
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const userId = await verifyFirebaseIdToken(idToken);

  if (!userId) {
    return Response.json({ error: 'Non authentifié' }, { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);

  const { data } = await supabase
    .from('connected_accounts')
    .select('github_access_token, github_username, vercel_access_token, vercel_team_id')
    .eq('user_id', userId)
    .maybeSingle();

  return Response.json({
    github: Boolean(data?.github_access_token),
    githubUsername: data?.github_username ?? null,
    vercel: Boolean(data?.vercel_access_token),
    vercelTeamId: data?.vercel_team_id ?? null,
  });
};

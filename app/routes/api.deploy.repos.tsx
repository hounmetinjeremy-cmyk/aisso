import type { LoaderFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

/**
 * Liste les dépôts GitHub de l'utilisateur connecté (via le jeton stocké côté
 * serveur), pour qu'il en choisisse un comme cible de déploiement — jamais le
 * jeton lui-même n'est renvoyé au client.
 */
export const loader: LoaderFunction = async ({ request, context }) => {
  try {
    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const userId = await verifyFirebaseIdToken(idToken);

    if (!userId) {
      return Response.json({ error: 'Non authentifié' }, { status: 401 });
    }

    const env = context.cloudflare.env as Env;

    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquant côté serveur.' }, { status: 500 });
    }

    const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);

    const { data } = await supabase
      .from('connected_accounts')
      .select('github_access_token')
      .eq('user_id', userId)
      .maybeSingle();

    const token = data?.github_access_token as string | undefined;

    if (!token) {
      return Response.json({ error: 'GitHub non connecté.' }, { status: 400 });
    }

    const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Aisso-App',
      },
    });

    if (!res.ok) {
      return Response.json({ error: `Impossible de lister les dépôts (HTTP ${res.status}).` }, { status: 502 });
    }

    const repos = await res.json<
      Array<{ full_name: string; name: string; owner: { login: string }; default_branch: string; private: boolean }>
    >();

    return Response.json({
      repos: repos.map((repo) => ({
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

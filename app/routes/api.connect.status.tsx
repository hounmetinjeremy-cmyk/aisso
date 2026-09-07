import type { LoaderFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

/**
 * Un jeton présent en base ne veut pas dire qu'il fonctionne encore (révoqué
 * côté GitHub, expiré...) — testé en réel : le badge "Connecté" restait vert
 * alors que /api/deploy/repos échouait en 401 avec ce même jeton, sans aucun
 * moyen pour l'utilisateur de comprendre pourquoi. Une requête légère vers
 * l'API GitHub valide que le jeton marche vraiment avant de dire "connecté".
 */
async function isGithubTokenValid(token: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'aisso' },
    });

    return response.ok;
  } catch {
    // Erreur réseau ponctuelle : ne pas afficher "déconnecté" à tort pour ça.
    return true;
  }
}

/**
 * Indique quels comptes (GitHub/Vercel) sont déjà connectés pour l'utilisateur
 * courant, sans jamais renvoyer les jetons eux-mêmes au client.
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
      .select('github_access_token, github_username, vercel_access_token, vercel_team_id')
      .eq('user_id', userId)
      .maybeSingle();

    const githubToken = data?.github_access_token as string | undefined;
    const githubConnected = Boolean(githubToken) && (await isGithubTokenValid(githubToken!));

    return Response.json({
      github: githubConnected,
      githubUsername: githubConnected ? (data?.github_username ?? null) : null,
      vercel: Boolean(data?.vercel_access_token),
      vercelTeamId: data?.vercel_team_id ?? null,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

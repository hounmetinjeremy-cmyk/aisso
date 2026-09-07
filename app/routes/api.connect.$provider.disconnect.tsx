import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { getOAuthProvider } from '~/lib/oauth-providers.server';

const ALLOWED_PROVIDERS = ['github', 'vercel'] as const;

/**
 * Déconnecte un compte OAuth (GitHub/Vercel) : vide les colonnes de jeton
 * correspondantes dans `connected_accounts` pour l'utilisateur courant, sans
 * toucher au reste de la ligne (l'autre fournisseur peut rester connecté).
 * Contrepartie de /api/connect/:provider/start + callback — sans cette
 * route, il n'existait aucun moyen de forcer une reconnexion propre si le
 * jeton stocké devenait invalide.
 */
export const action: ActionFunction = async ({ request, context, params }) => {
  const provider = params.provider;

  if (!provider || !ALLOWED_PROVIDERS.includes(provider as (typeof ALLOWED_PROVIDERS)[number])) {
    return Response.json({ error: 'Fournisseur inconnu' }, { status: 400 });
  }

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

    const tokenColumn = provider === 'github' ? 'github_access_token' : 'vercel_access_token';
    const { data: existing } = await supabase
      .from('connected_accounts')
      .select(tokenColumn)
      .eq('user_id', userId)
      .maybeSingle();

    const existingToken = (existing as Record<string, string | null> | null)?.[tokenColumn];

    /*
     * Révocation best-effort côté fournisseur : "Déconnecter" ne se contentait avant que
     * d'oublier le jeton localement, en le laissant valide indéfiniment côté GitHub. Une
     * révocation échouée ne doit jamais empêcher l'utilisateur de se déconnecter côté Aïsso.
     */
    if (existingToken) {
      try {
        const oauthProvider = getOAuthProvider(provider, env);
        await oauthProvider.revokeToken?.(existingToken);
      } catch {
        // Non bloquant.
      }
    }

    const clearedColumns =
      provider === 'github'
        ? { github_access_token: null, github_username: null }
        : { vercel_access_token: null, vercel_team_id: null };

    const { error: updateError } = await supabase
      .from('connected_accounts')
      .update({ ...clearedColumns, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (updateError) {
      return Response.json({ error: `Déconnexion impossible : ${updateError.message}` }, { status: 500 });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

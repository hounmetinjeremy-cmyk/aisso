import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { getOAuthProvider } from '~/lib/oauth-providers.server';

const ALLOWED_PROVIDERS = ['github', 'vercel'];
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Démarre le flux OAuth : vérifie l'utilisateur (jeton Firebase), crée un
 * "state" à usage unique reliant ce flux à son compte, et renvoie l'URL
 * d'autorisation vers laquelle le navigateur doit être redirigé.
 */
export const action: ActionFunction = async ({ request, context, params }) => {
  const provider = params.provider;

  if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
    return Response.json({ error: 'Fournisseur inconnu' }, { status: 400 });
  }

  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const userId = await verifyFirebaseIdToken(idToken);

  if (!userId) {
    return Response.json({ error: 'Non authentifié' }, { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);

  const state = crypto.randomUUID();

  const { error: insertError } = await supabase.from('oauth_states').insert({ state, user_id: userId, provider });

  if (insertError) {
    return Response.json({ error: "Impossible de démarrer la connexion" }, { status: 500 });
  }

  // Purge non-bloquante des states expirés (usage unique, courte durée de vie).
  supabase
    .from('oauth_states')
    .delete()
    .lt('created_at', new Date(Date.now() - STATE_TTL_MS).toISOString())
    .then(() => {});

  const redirectUri = `${env.APP_BASE_URL}/api/connect/${provider}/callback`;

  try {
    const oauthProvider = getOAuthProvider(provider, env);
    const url = oauthProvider.buildAuthorizeUrl({ redirectUri, state });

    return Response.json({ url });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

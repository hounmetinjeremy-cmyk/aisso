import type { LoaderFunction } from '@remix-run/cloudflare';
import { redirect } from '@remix-run/cloudflare';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { getOAuthProvider } from '~/lib/oauth-providers.server';

const ALLOWED_PROVIDERS = ['github', 'vercel'];
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Reçoit la redirection du fournisseur OAuth (GitHub/Vercel) après que
 * l'utilisateur a autorisé l'accès. Retrouve le compte via le "state" à
 * usage unique (aucun en-tête d'authentification n'est disponible ici —
 * c'est une simple navigation du navigateur), échange le code contre un
 * jeton d'accès, puis l'enregistre.
 */
export const loader: LoaderFunction = async ({ request, context, params }) => {
  const provider = params.provider;
  const env = context.cloudflare.env as Env;

  /*
   * APP_BASE_URL manquant : impossible de construire une redirection propre,
   * on répond en texte brut plutôt que de laisser `new URL(undefined)` jeter
   * une exception non interceptée (transformée en page d'erreur générique).
   */
  if (!env.APP_BASE_URL) {
    return new Response('Configuration serveur incomplète (APP_BASE_URL manquant).', { status: 500 });
  }

  const appUrl = new URL(env.APP_BASE_URL);

  const failure = (reason: string) => {
    const url = new URL(appUrl);
    url.searchParams.set('connect_error', reason);

    return redirect(url.toString());
  };

  if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
    return failure('provider_inconnu');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  if (providerError) {
    return failure('refuse_par_utilisateur');
  }

  if (!code || !state) {
    return failure('parametres_manquants');
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return failure('supabase_non_configure');
  }

  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);

  /*
   * Encapsule le reste : toute exception non interceptée ici deviendrait une
   * page d'erreur générique de Remix au lieu d'une redirection propre avec
   * un message compréhensible pour l'utilisateur.
   */
  try {
    const { data: stateRow, error: stateError } = await supabase
      .from('oauth_states')
      .select('user_id, provider, created_at')
      .eq('state', state)
      .maybeSingle();

    /*
     * Le state est à usage unique : on le supprime dès qu'on l'a lu, qu'il
     * soit valide ou non.
     */
    await supabase.from('oauth_states').delete().eq('state', state);

    if (stateError || !stateRow || stateRow.provider !== provider) {
      return failure('state_invalide');
    }

    const isExpired = Date.now() - new Date(stateRow.created_at).getTime() > STATE_TTL_MS;

    if (isExpired) {
      return failure('lien_expire');
    }

    const oauthProvider = getOAuthProvider(provider, env);
    const redirectUri = `${env.APP_BASE_URL}/api/connect/${provider}/callback`;
    const { accessToken, accountLabel } = await oauthProvider.exchangeCode({ code, redirectUri });

    const tokenColumns =
      provider === 'github'
        ? { github_access_token: accessToken, github_username: accountLabel ?? null }
        : { vercel_access_token: accessToken, vercel_team_id: accountLabel ?? null };

    const { error: upsertError } = await supabase
      .from('connected_accounts')
      .upsert(
        { user_id: stateRow.user_id, updated_at: new Date().toISOString(), ...tokenColumns },
        { onConflict: 'user_id' },
      );

    if (upsertError) {
      return failure('sauvegarde_echouee');
    }
  } catch {
    return failure('echange_code_echoue');
  }

  const successUrl = new URL(appUrl);
  successUrl.searchParams.set('connected', provider);

  return redirect(successUrl.toString());
};

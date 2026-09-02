/**
 * Configuration des fournisseurs OAuth (GitHub, Vercel) pour la connexion de
 * compte utilisateur. Chaque fournisseur sait construire son URL
 * d'autorisation et échanger un "code" contre un jeton d'accès.
 */

export interface OAuthTokenResult {
  accessToken: string;

  /** Identifiant lisible côté fournisseur (ex: login GitHub), si disponible. */
  accountLabel?: string;
}

export interface OAuthProvider {
  buildAuthorizeUrl(params: { redirectUri: string; state: string }): string;
  exchangeCode(params: { code: string; redirectUri: string }): Promise<OAuthTokenResult>;
}

/* eslint-disable @typescript-eslint/naming-convention -- paramètres de propriété nommés selon la convention OAuth (clientId/clientSecret), pas besoin de préfixe underscore */
class GitHubOAuthProvider implements OAuthProvider {
  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  buildAuthorizeUrl({ redirectUri, state }: { redirectUri: string; state: string }): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);

    /*
     * "repo" est nécessaire pour pouvoir pousser des commits sur les dépôts
     * (publics et privés) de l'utilisateur.
     */
    url.searchParams.set('scope', 'repo');
    url.searchParams.set('state', state);

    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenResult> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      throw new Error(`Échange du code GitHub échoué (HTTP ${response.status})`);
    }

    const data = await response.json<{ access_token?: string; error?: string; error_description?: string }>();

    if (!data.access_token) {
      throw new Error(data.error_description || data.error || 'GitHub a refusé le code fourni');
    }

    let accountLabel: string | undefined;

    try {
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${data.access_token}`,
          'User-Agent': 'Aisso-App',
          Accept: 'application/vnd.github+json',
        },
      });

      if (userResponse.ok) {
        const user = await userResponse.json<{ login?: string }>();
        accountLabel = user.login;
      }
    } catch {
      // Non bloquant : on garde le jeton même si on n'a pas pu récupérer le login.
    }

    return { accessToken: data.access_token, accountLabel };
  }
}

/**
 * Vercel expose son flux OAuth via la console "Integrations" : chaque
 * intégration a un "slug" et l'autorisation démarre sur
 * vercel.com/integrations/<slug>/new (pas sur un endpoint générique
 * vercel.com/oauth/authorize — testé en réel, celui-ci renvoie "App ID is
 * invalid" pour un client_id issu de la Integration Console). Ce flux
 * "install" ne prend pas client_id/redirect_uri en paramètres : Vercel
 * connaît déjà la Redirect URL configurée sur l'intégration elle-même, on
 * transmet juste le state pour le round-trip CSRF.
 */
class VercelOAuthProvider implements OAuthProvider {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private integrationSlug: string,
  ) {}

  buildAuthorizeUrl({ state }: { redirectUri: string; state: string }): string {
    if (!this.clientId || !this.integrationSlug) {
      throw new Error(
        'Intégration Vercel pas encore configurée : crée-la sur vercel.com/dashboard/integrations/console, ' +
          'puis renseigne VERCEL_OAUTH_CLIENT_ID, VERCEL_OAUTH_CLIENT_SECRET et VERCEL_INTEGRATION_SLUG.',
      );
    }

    const url = new URL(`https://vercel.com/integrations/${this.integrationSlug}/new`);
    url.searchParams.set('state', state);

    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokenResult> {
    const response = await fetch('https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      throw new Error(`Échange du code Vercel échoué (HTTP ${response.status})`);
    }

    const data = await response.json<{ access_token?: string; team_id?: string; error?: { message?: string } }>();

    if (!data.access_token) {
      throw new Error(data.error?.message || 'Vercel a refusé le code fourni');
    }

    return { accessToken: data.access_token, accountLabel: data.team_id };
  }
}

export function getOAuthProvider(provider: string, env: Env): OAuthProvider {
  if (provider === 'github') {
    return new GitHubOAuthProvider(env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET);
  }

  if (provider === 'vercel') {
    return new VercelOAuthProvider(
      env.VERCEL_OAUTH_CLIENT_ID,
      env.VERCEL_OAUTH_CLIENT_SECRET,
      env.VERCEL_INTEGRATION_SLUG,
    );
  }

  throw new Error(`Fournisseur OAuth inconnu : ${provider}`);
}

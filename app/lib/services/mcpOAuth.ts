/**
 * OAuth 2.1 + PKCE helpers for remote MCP servers (ex: remote-mcp-github-oauth).
 *
 * Flow:
 * 1. User clicks "Connecter le compte" on a streamable-http / sse server
 * 2. We generate PKCE, optionally DCR, redirect to /authorize
 * 3. Callback receives ?code=… → exchange for tokens
 * 4. Tokens are stored in MCP settings (headers.Authorization) and used on every connection
 */

const MCP_OAUTH_STATE_KEY = 'mcp_oauth_pending';
const FETCH_TIMEOUT_MS = 8000;

export type McpOAuthPending = {
  serverName: string;
  serverUrl: string;
  codeVerifier: string;
  state: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
};

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);

  const codeVerifier = base64UrlEncode(array);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(digest);

  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);

  return base64UrlEncode(array);
}

/** Normalize server base URL (strip /sse or /mcp suffix). */
export function getServerOrigin(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    let path = u.pathname.replace(/\/+$/, '');
    path = path.replace(/\/(sse|mcp)$/i, '');

    return `${u.origin}${path}` || u.origin;
  } catch {
    return serverUrl;
  }
}

export function getRedirectUri(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return `${window.location.origin}/mcp-oauth/callback`;
}

export function savePendingOAuth(pending: McpOAuthPending): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(MCP_OAUTH_STATE_KEY, JSON.stringify(pending));
}

export function loadPendingOAuth(): McpOAuthPending | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(MCP_OAUTH_STATE_KEY);

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as McpOAuthPending;
  } catch {
    return null;
  }
}

export function clearPendingOAuth(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(MCP_OAUTH_STATE_KEY);
}

/**
 * Discover OAuth endpoints for a remote MCP server.
 * Tries well-known metadata, then falls back to Cloudflare-style paths.
 * Never blocks more than a few seconds — always returns a usable result.
 */
export async function discoverOAuthEndpoints(serverUrl: string): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}> {
  const origin = getServerOrigin(serverUrl);

  // 1) Protected resource metadata (RFC 9728)
  try {
    const prmRes = await fetchWithTimeout(`${origin}/.well-known/oauth-protected-resource`, {
      headers: { Accept: 'application/json' },
    });

    if (prmRes.ok) {
      const prm = (await prmRes.json()) as { authorization_servers?: string[] };
      const asUrl = prm.authorization_servers?.[0];

      if (asUrl) {
        const asMetaRes = await fetchWithTimeout(
          `${asUrl.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`,
          { headers: { Accept: 'application/json' } },
        );

        if (asMetaRes.ok) {
          const meta = (await asMetaRes.json()) as {
            authorization_endpoint?: string;
            token_endpoint?: string;
            registration_endpoint?: string;
          };

          if (meta.authorization_endpoint && meta.token_endpoint) {
            return {
              authorizationEndpoint: meta.authorization_endpoint,
              tokenEndpoint: meta.token_endpoint,
              registrationEndpoint: meta.registration_endpoint,
            };
          }
        }
      }
    }
  } catch {
    // ignore and fall through
  }

  // 2) Authorization server metadata on the same origin
  try {
    const asRes = await fetchWithTimeout(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' },
    });

    if (asRes.ok) {
      const meta = (await asRes.json()) as {
        authorization_endpoint?: string;
        token_endpoint?: string;
        registration_endpoint?: string;
      };

      if (meta.authorization_endpoint && meta.token_endpoint) {
        return {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          registrationEndpoint: meta.registration_endpoint,
        };
      }
    }
  } catch {
    // ignore
  }

  // 3) Cloudflare workers-oauth-provider style defaults (always works)
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
  };
}

/**
 * Dynamic Client Registration (RFC 7591) if the server supports it.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchWithTimeout(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Aïsso',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dynamic client registration failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { client_id: string; client_secret?: string };

  return { clientId: data.client_id, clientSecret: data.client_secret };
}

/**
 * Start the OAuth authorization flow in the browser.
 * Saves pending state to localStorage and ALWAYS redirects the window.
 * Discovery / DCR failures must not block the redirect to /authorize.
 */
export async function startMcpOAuthFlow(serverName: string, serverUrl: string): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('OAuth uniquement disponible dans le navigateur');
  }

  const redirectUri = getRedirectUri();
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = generateState();

  let endpoints: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
  };

  try {
    endpoints = await discoverOAuthEndpoints(serverUrl);
  } catch (e) {
    console.warn('[mcp-oauth] discovery failed, using /authorize fallback', e);

    const origin = getServerOrigin(serverUrl);
    endpoints = {
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      registrationEndpoint: `${origin}/register`,
    };
  }

  let clientId = 'aisso';
  let clientSecret: string | undefined;

  // DCR is optional — never block redirect more than timeout
  if (endpoints.registrationEndpoint) {
    try {
      const reg = await registerClient(endpoints.registrationEndpoint, redirectUri);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    } catch (e) {
      console.warn('[mcp-oauth] DCR failed, using public client id "aisso"', e);
    }
  }

  savePendingOAuth({
    serverName,
    serverUrl,
    codeVerifier,
    state,
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
  });

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', 'openid profile email');

  const target = authUrl.toString();
  console.info('[mcp-oauth] redirecting to authorize:', target);

  // Force navigation — this is the critical step the user expects
  window.location.assign(target);
}

/**
 * Exchange authorization code for tokens (call from callback page).
 */
export async function exchangeCodeForTokens(
  code: string,
  pending: McpOAuthPending,
): Promise<{ access_token: string; refresh_token?: string; token_type?: string; expires_in?: number }> {
  if (!pending.tokenEndpoint) {
    throw new Error('Token endpoint missing in pending OAuth state');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId || 'aisso',
    code_verifier: pending.codeVerifier,
  });

  if (pending.clientSecret) {
    body.set('client_secret', pending.clientSecret);
  }

  const res = await fetchWithTimeout(pending.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
  };
}

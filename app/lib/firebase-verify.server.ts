/**
 * Vérification côté serveur des jetons d'identité Firebase (Google Sign-In),
 * sans firebase-admin (incompatible avec le runtime Cloudflare Workers — il
 * dépend de Node). Implémentation directe avec l'API Web Crypto standard,
 * en suivant la procédure officielle documentée par Google :
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 *
 * Nécessaire pour rattacher toute écriture sensible (snapshots de projet,
 * jetons OAuth GitHub/Vercel) à un utilisateur *vérifié* — et non
 * simplement déclaré par le client — avant d'utiliser la clé Supabase
 * service_role (qui contourne toutes les policies RLS).
 */

const FIREBASE_PROJECT_ID = 'aisso-d9de3';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJson(base64Url: string): any {
  const bytes = base64UrlToUint8Array(base64Url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

interface JwkKey {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg: string;
}

async function fetchGoogleJwks(): Promise<JwkKey[]> {
  // @ts-ignore -- l'API Cache n'est disponible que dans le runtime Workers.
  const cache: Cache | undefined = typeof caches !== 'undefined' ? (caches as any).default : undefined;
  const cacheKey = new Request(JWKS_URL);

  if (cache) {
    const cached = await cache.match(cacheKey);

    if (cached) {
      const { keys } = await cached.json<{ keys: JwkKey[] }>();
      return keys;
    }
  }

  const res = await fetch(JWKS_URL);

  if (!res.ok) {
    throw new Error(`Impossible de récupérer les clés publiques Google (HTTP ${res.status})`);
  }

  if (cache) {
    // Google renvoie un Cache-Control avec max-age : on le respecte tel quel.
    await cache.put(cacheKey, res.clone());
  }

  const { keys } = await res.json<{ keys: JwkKey[] }>();

  return keys;
}

/**
 * Vérifie un jeton d'identité Firebase (signature RS256 + claims standard).
 * Renvoie l'UID Firebase vérifié, ou null si le jeton est invalide/expiré.
 */
export async function verifyFirebaseIdToken(idToken: string | null | undefined): Promise<string | null> {
  if (!idToken) {
    return null;
  }

  const parts = idToken.split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;

  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) {
    return null;
  }

  let keys: JwkKey[];

  try {
    keys = await fetchGoogleJwks();
  } catch {
    return null;
  }

  const jwk = keys.find((k) => k.kid === header.kid);

  if (!jwk) {
    return null;
  }

  let cryptoKey: CryptoKey;

  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(signatureB64);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature as BufferSource,
    signingInput as BufferSource,
  );

  if (!valid) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_SECONDS = 60;

  if (
    payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` ||
    payload.aud !== FIREBASE_PROJECT_ID ||
    typeof payload.exp !== 'number' ||
    payload.exp + CLOCK_SKEW_SECONDS < now ||
    typeof payload.iat !== 'number' ||
    payload.iat - CLOCK_SKEW_SECONDS > now ||
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0
  ) {
    return null;
  }

  return payload.sub;
}

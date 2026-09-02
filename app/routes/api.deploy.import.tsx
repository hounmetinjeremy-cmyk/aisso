import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

const GITHUB_API = 'https://api.github.com';
const MAX_FILES = 400;
const MAX_FILE_BYTES = 250_000;

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Aisso-App',
  };
}

/**
 * Importe les fichiers texte d'un dépôt GitHub existant dans le projet en
 * cours (sens inverse de /api/deploy/commit) — pour ouvrir/continuer un
 * projet déjà présent sur GitHub depuis Aïsso. Les fichiers binaires et
 * volumineux sont ignorés (ce sont des exceptions raisonnables pour un
 * import de code source, pas des cas à gérer silencieusement en douceur).
 */
export const action: ActionFunction = async ({ request, context }) => {
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

    const body = await request.json<{ owner?: string; repo?: string; branch?: string }>();
    const owner = body.owner?.trim();
    const repo = body.repo?.trim();
    const branch = body.branch?.trim();

    if (!owner || !repo || !branch) {
      return Response.json({ error: 'Dépôt cible manquant (owner, repo, branch).' }, { status: 400 });
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

    const treeRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers: githubHeaders(token) },
    );

    if (!treeRes.ok) {
      return Response.json({ error: `Impossible de lire le dépôt (HTTP ${treeRes.status}).` }, { status: 502 });
    }

    const treeData = await treeRes.json<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    }>();

    const blobEntries = treeData.tree.filter(
      (entry) => entry.type === 'blob' && (entry.size ?? 0) <= MAX_FILE_BYTES,
    );

    if (blobEntries.length > MAX_FILES) {
      return Response.json(
        { error: `Dépôt trop volumineux (${blobEntries.length} fichiers > ${MAX_FILES} max).` },
        { status: 400 },
      );
    }

    const skipped = treeData.tree.length - blobEntries.length;

    const files = await Promise.all(
      blobEntries.map(async (entry) => {
        const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${entry.sha}`, {
          headers: githubHeaders(token),
        });

        if (!blobRes.ok) {
          return null;
        }

        const blob = await blobRes.json<{ content: string; encoding: string }>();

        if (blob.encoding !== 'base64') {
          return null;
        }

        try {
          const binary = atob(blob.content.replace(/\n/g, ''));
          const bytes = new Uint8Array(binary.length);

          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }

          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

          return { path: entry.path, content };
        } catch {
          // Décodage UTF-8 strict échoué : fichier binaire, on l'ignore pour cet import.
          return null;
        }
      }),
    );

    const textFiles = files.filter((file): file is { path: string; content: string } => file !== null);

    return Response.json({
      files: textFiles,
      skipped: skipped + (blobEntries.length - textFiles.length),
      truncated: treeData.truncated,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

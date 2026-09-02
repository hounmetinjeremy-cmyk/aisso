import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { importRepoFiles } from '~/lib/github-import.server';

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

    const result = await importRepoFiles(token, { owner, repo, branch });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

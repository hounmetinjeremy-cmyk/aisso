import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { commitFilesToRepo, type CommitFileInput } from '~/lib/github-commit.server';

const MAX_FILES = 300;

/**
 * Reçoit l'état actuel des fichiers du projet (depuis FilesStore côté client,
 * qui est la source de vérité depuis le retrait du WebContainer) et les
 * committe sur le dépôt GitHub connecté de l'utilisateur, avec le jeton
 * stocké côté serveur. Si le dépôt Vercel de l'utilisateur est lié
 * nativement à ce dépôt GitHub, ce commit déclenche automatiquement un
 * déploiement Vercel — inutile d'appeler l'API Vercel séparément ici.
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

    const body = await request.json<{
      owner?: string;
      repo?: string;
      branch?: string;
      commitMessage?: string;
      files?: CommitFileInput[];
    }>();

    const owner = body.owner?.trim();
    const repo = body.repo?.trim();
    const branch = body.branch?.trim();
    const files = body.files;

    if (!owner || !repo || !branch) {
      return Response.json({ error: 'Dépôt cible manquant (owner, repo, branch).' }, { status: 400 });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return Response.json({ error: 'Aucun fichier à committer.' }, { status: 400 });
    }

    if (files.length > MAX_FILES) {
      return Response.json({ error: `Trop de fichiers (${files.length} > ${MAX_FILES} max par commit).` }, { status: 400 });
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

    const commitMessage = body.commitMessage?.trim() || 'Mise à jour depuis Aïsso';

    const result = await commitFilesToRepo(token, { owner, repo, branch, message: commitMessage, files });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

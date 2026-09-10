import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { importRepoFiles } from '~/lib/github-import.server';

/**
 * Importe les fichiers (texte et binaires) d'un dépôt GitHub existant dans
 * le projet en cours (sens inverse de /api/deploy/commit) — pour
 * ouvrir/continuer un projet déjà présent sur GitHub depuis Aïsso. Seuls les
 * fichiers vraiment trop volumineux restent exclus (voir github-import.server.ts).
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

    const body = await request.json<{ owner?: string; repo?: string; branch?: string; chatId?: string }>();
    const owner = body.owner?.trim();
    const repo = body.repo?.trim();
    const branch = body.branch?.trim();
    const chatId = body.chatId?.trim() || 'default';

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

    /*
     * Ecrit dans Supabase lot par lot, au fur et a mesure de la recuperation
     * depuis GitHub (voir importRepoFiles/onBatch) — plutot qu'un seul gros
     * insert a la fin qui suppose que tout le depot a deja tenu en memoire
     * jusque-la. Un Worker Cloudflare est plafonne a 128 Mo : sur un gros
     * depot, tout accumuler avant d'ecrire faisait courir un vrai risque de
     * depassement memoire en plein import.
     */
    const result = await importRepoFiles(token, { owner, repo, branch }, async (batch) => {
      const { error: insertError } = await supabase.from('file_history').insert(
        batch.map((file) => ({
          session_id: chatId,
          user_id: userId,
          file_path: file.path,
          content: file.content,
          change_source: 'import',
        })),
      );

      if (insertError) {
        // L'import GitHub continue quand meme : la sauvegarde Supabase n'est qu'une trace, jamais bloquante.
        console.warn('[api.deploy.import] echec sauvegarde Supabase (lot)', insertError);
      }
    });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

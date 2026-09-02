/**
 * Jeton GitHub stocké de l'utilisateur connecté — partagé par
 * github-auto-import.ts (détection déterministe, voir ce fichier pour le
 * contexte complet) et les routes /api/deploy/*.
 *
 * Une version antérieure exposait aussi list_github_repos/import_github_repo
 * comme outils IA (function calling) que le modèle pouvait appeler
 * lui-même. Retirée : testé en réel, Gemini "thinking" (modèle par défaut
 * de l'app) plante dessus faute de support de thought_signature dans le
 * SDK IA installé — un modèle qui ne trouve pas de nom de dépôt précis via
 * la détection déterministe tentait ces outils en secours et faisait
 * planter tout l'échange. La détection déterministe (jamais une décision
 * du modèle) est désormais le seul chemin.
 */

import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

export async function getGithubToken(env: Env, userId: string): Promise<string | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await supabase
    .from('connected_accounts')
    .select('github_access_token')
    .eq('user_id', userId)
    .maybeSingle();

  return (data?.github_access_token as string | undefined) ?? null;
}

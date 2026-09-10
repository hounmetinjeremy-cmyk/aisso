import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

export interface GithubConnectionStatus {
  isConnected: boolean;
  username: string | null;
}

/**
 * Statut de connexion GitHub (sans jamais exposer le jeton lui-même) —
 * injecté dans le prompt système pour que le modèle sache si un compte est
 * connecté au lieu de deviner ou de prétendre ne pas pouvoir le savoir (voir
 * database_instructions/supabase pour le même pattern côté Supabase).
 */
export async function getGithubConnectionStatus(env: Env, userId: string | null): Promise<GithubConnectionStatus> {
  if (!userId || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { isConnected: false, username: null };
  }

  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await supabase
    .from('connected_accounts')
    .select('github_access_token, github_username')
    .eq('user_id', userId)
    .maybeSingle();

  return {
    isConnected: Boolean(data?.github_access_token),
    username: (data?.github_username as string | undefined) ?? null,
  };
}

import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

/**
 * Meme pattern que github-tools.ts (getGithubAccessToken) — le jeton Vercel
 * "app" (connecte via le bouton "+" -> Connecteurs, PAS un serveur MCP) est
 * stocke cote serveur dans connected_accounts (voir
 * api.connect.$provider.callback.tsx), jamais expose au client.
 */
export async function getVercelAccessToken(env: Env, userId: string | null): Promise<string | null> {
  if (!userId || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await supabase
    .from('connected_accounts')
    .select('vercel_access_token')
    .eq('user_id', userId)
    .maybeSingle();

  return (data?.vercel_access_token as string | undefined) ?? null;
}

import type { ActionFunction } from '@remix-run/cloudflare';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { FILE_READ_TOOL_NAME_PATTERN } from '~/lib/.server/llm/mcp-file-capture.server';
import { indexGithubProjectSequential } from '~/lib/.server/project-indexer.server';
import { indexGithubProjectViaMcp, type McpFileContentsCaller } from '~/lib/.server/project-indexer-mcp.server';

/**
 * Déclenchement DIRECT de l'analyse en profondeur d'un dépôt, sans passer
 * par le chat/l'IA — le bouton "Analyser ce dépôt en profondeur" appelle
 * cette route. Contourne le vrai problème rencontré en usage réel : même
 * avec l'outil analyze_github_project disponible et une consigne système
 * placée en tout premier, certains modèles (notamment les plus rapides/
 * économiques) n'appellent tout simplement pas l'outil et continuent de
 * lister des dossiers. Ici, aucune décision de modèle n'entre en jeu.
 *
 * Mêmes deux sources que analyze_github_project (voir project-index-tools.ts) :
 * jeton GitHub "app" (connected_accounts) si connecté, sinon un outil MCP de
 * lecture de fichier déjà connecté par l'utilisateur (ex: get_file_contents).
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

    const body = await request.json<{ owner?: string; repo?: string; branch?: string; mcpConfig?: MCPConfig }>();
    const owner = body.owner?.trim();
    const repo = body.repo?.trim();
    const branch = body.branch?.trim() || 'main';

    if (!owner || !repo) {
      return Response.json({ error: 'Dépôt cible manquant (owner, repo).' }, { status: 400 });
    }

    const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);

    const { data } = await supabase
      .from('connected_accounts')
      .select('github_access_token')
      .eq('user_id', userId)
      .maybeSingle();

    const githubToken = data?.github_access_token as string | undefined;

    let callMcpTool: McpFileContentsCaller | null = null;

    if (!githubToken) {
      const mcpService = MCPService.getInstance();

      await mcpService.ensureConfig(body.mcpConfig || { mcpServers: {} }).catch(() => {});

      const mcpFileTool = Object.entries(mcpService.tools).find(
        ([toolName, toolDef]) => FILE_READ_TOOL_NAME_PATTERN.test(toolName) && typeof toolDef.execute === 'function',
      )?.[1];

      if (!mcpFileTool) {
        return Response.json(
          { error: 'Aucune connexion GitHub disponible (ni compte "app", ni outil MCP de lecture de fichier).' },
          { status: 400 },
        );
      }

      callMcpTool = async (input) => mcpFileTool.execute!(input, { messages: [], toolCallId: 'project-index-button' });
    }

    const result = githubToken
      ? await indexGithubProjectSequential(supabase, userId, githubToken, { owner, repo, branch })
      : await indexGithubProjectViaMcp(supabase, userId, callMcpTool!, { owner, repo, branch });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Erreur inconnue' }, { status: 500 });
  }
};

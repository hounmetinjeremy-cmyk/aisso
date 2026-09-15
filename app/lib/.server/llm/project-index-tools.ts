import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  indexGithubProjectSequential,
  listIndexedFilePaths,
  readIndexedFile,
} from '~/lib/.server/project-indexer.server';
import { indexGithubProjectViaMcp, type McpFileContentsCaller } from '~/lib/.server/project-indexer-mcp.server';
import { FILE_READ_TOOL_NAME_PATTERN } from '~/lib/.server/llm/mcp-file-capture.server';
import type { ProgressAnnotation } from '~/types/context';

/**
 * Outils exposés au modèle pour comprendre en profondeur un dépôt GitHub
 * connecté — remplace le comportement précédent où seule la liste des noms
 * de fichiers était visible (via les outils MCP), jamais leur contenu.
 *
 * Deux sources possibles pour analyze_github_project, choisies automatiquement
 * selon ce qui est disponible pour l'utilisateur (jamais besoin des deux) :
 * - githubToken (connexion GitHub "app", connected_accounts) -> lecture REST
 *   directe (project-indexer.server.ts), la plus rapide.
 * - à défaut, un outil MCP de lecture de fichier déjà connecté par
 *   l'utilisateur (ex: "get_file_contents") -> même résultat, piloté
 *   directement au lieu de compter sur le modèle pour tout relire lui-même
 *   tour après tour (project-indexer-mcp.server.ts).
 */
export function buildProjectIndexTools(params: {
  supabase: SupabaseClient | null;
  userId: string | null;
  githubToken: string | null;

  /** Outils MCP déjà connectés par l'utilisateur (mcpService.tools) — pour la source de secours ci-dessus. */
  mcpTools?: ToolSet;

  /*
   * Pour publier une progression pendant l'indexation (qui peut prendre du
   * temps sur un gros dépôt) — même schéma "data-progress" que le reste du
   * tour de chat (voir api.chat.ts), même label réutilisé à chaque appel
   * pour que l'UI remplace l'entrée au lieu d'en empiler des centaines.
   */
  writer?: Pick<UIMessageStreamWriter, 'write'>;
  nextProgressOrder?: () => number;
}): ToolSet {
  const { supabase, userId, githubToken, mcpTools, writer, nextProgressOrder } = params;

  const mcpFileTool = Object.entries(mcpTools ?? {}).find(
    ([toolName, toolDef]) => FILE_READ_TOOL_NAME_PATTERN.test(toolName) && typeof toolDef.execute === 'function',
  )?.[1];

  if (!supabase || !userId || (!githubToken && !mcpFileTool)) {
    return {};
  }

  const callMcpTool: McpFileContentsCaller | null = mcpFileTool
    ? async (input) => mcpFileTool.execute!(input, { messages: [], toolCallId: 'project-indexer' })
    : null;

  return {
    analyze_github_project: tool({
      description:
        "ALWAYS call this FIRST — before listing folders, before opening files yourself — whenever asked what a connected GitHub project does, how it works, or to read/analyze/understand it in depth. Opens and reads the COMPLETE content of every relevant file in the repo, one at a time (never all in memory), and stores it — this is how you actually see real code instead of guessing from file/folder names. One call indexes the ENTIRE repo, not a sample; it may take a while on a large repo, that's expected, let it finish and don't ask the user to confirm partway. After it returns, use list_indexed_project_files and read_indexed_project_file to read what was stored. Call it again on the same owner/repo/branch only if its result says complete: false.",
      inputSchema: z.object({
        owner: z.string().describe('Propriétaire du dépôt GitHub (utilisateur ou organisation)'),
        repo: z.string().describe('Nom du dépôt'),
        branch: z.string().describe('Branche à analyser (ex: main)'),
      }),
      execute: async ({ owner, repo, branch }) => {
        const onProgress = (p: { current: number; total: number; fileName: string }) => {
          writer?.write({
            type: 'data-progress',
            data: {
              type: 'progress',
              label: 'project-index',
              status: 'in-progress',
              order: nextProgressOrder?.() ?? 0,
              message: `Analyse du projet : ${p.current}/${p.total} — ${p.fileName}`,
            } satisfies ProgressAnnotation,
          });
        };

        /*
         * Un aller-retour réseau tiers (GitHub, ou un serveur MCP hors de
         * notre contrôle) sur des centaines de fichiers a forcément un point
         * d'échec possible quelque part — ne jamais laisser une exception ici
         * remonter et casser tout le tour de chat, renvoyer une erreur lisible
         * au modèle à la place.
         */
        try {
          const result =
            githubToken && supabase
              ? await indexGithubProjectSequential(supabase, userId, githubToken, { owner, repo, branch }, onProgress)
              : await indexGithubProjectViaMcp(supabase, userId, callMcpTool!, { owner, repo, branch }, onProgress);

          writer?.write({
            type: 'data-progress',
            data: {
              type: 'progress',
              label: 'project-index',
              status: 'complete',
              order: nextProgressOrder?.() ?? 0,
              message: `Analyse du projet terminée : ${result.filesIndexed} fichier(s) indexé(s).`,
            } satisfies ProgressAnnotation,
          });

          return {
            message: `${result.filesIndexed} fichier(s) lu(s) et stocké(s) en base (${result.filesAlreadyIndexed} déjà indexés précédemment, ${result.totalMatchingFiles} fichier(s) pertinent(s) au total).${
              result.complete
                ? ' Indexation complète — tous les fichiers pertinents sont maintenant stockés.'
                : ` Dépôt exceptionnellement volumineux : ${result.filesRemaining} fichier(s) restent à indexer — rappelle analyze_github_project avec le même owner/repo/branch pour continuer.`
            } Utilise list_indexed_project_files pour voir la liste, puis read_indexed_project_file pour lire le contenu d'un fichier précis.`,
            ...result,
          };
        } catch (error) {
          writer?.write({
            type: 'data-progress',
            data: {
              type: 'progress',
              label: 'project-index',
              status: 'error',
              order: nextProgressOrder?.() ?? 0,
              message: "Échec de l'analyse du projet.",
            } satisfies ProgressAnnotation,
          });

          return {
            message: `L'indexation a échoué : ${error instanceof Error ? error.message : 'erreur inconnue'}. Le dépôt/la branche existe-t-il bien ? Réessaie, ou explore le projet via les outils MCP disponibles en attendant.`,
          };
        }
      },
    }),
    list_indexed_project_files: tool({
      description:
        'Liste les chemins de fichiers déjà indexés (via analyze_github_project) pour un dépôt — pas leur contenu, juste la liste.',
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
      }),
      execute: async ({ owner, repo, branch }) => {
        const paths = await listIndexedFilePaths(supabase, userId, { owner, repo, branch });

        if (paths.length === 0) {
          return {
            message: "Aucun fichier indexé pour ce dépôt/cette branche. Appelle d'abord analyze_github_project.",
            paths: [],
          };
        }

        return { paths };
      },
    }),
    read_indexed_project_file: tool({
      description:
        "Lit le contenu complet d'un fichier déjà indexé (via analyze_github_project) directement depuis la base — rapide, aucun appel GitHub nécessaire.",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        path: z.string().describe('Chemin exact du fichier (voir list_indexed_project_files)'),
      }),
      execute: async ({ owner, repo, branch, path }) => {
        const file = await readIndexedFile(supabase, userId, { owner, repo, branch, path });

        if (!file) {
          return {
            message: `Fichier "${path}" non trouvé dans l'index. Vérifie le chemin avec list_indexed_project_files, ou lance analyze_github_project si ce n'est pas encore fait.`,
          };
        }

        if (file.is_binary) {
          return {
            message: `"${path}" est un fichier binaire (${file.size} octets) — contenu non lisible en texte.`,
          };
        }

        return { path: file.path, content: file.content, size: file.size, indexedAt: file.indexed_at };
      },
    }),
  };
}

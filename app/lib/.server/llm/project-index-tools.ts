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
        "Indexe en profondeur un dépôt GitHub connecté : ouvre et lit le contenu COMPLET de CHAQUE fichier pertinent un par un (jamais tout en mémoire d'un coup) et le stocke en base — à utiliser dès qu'une question porte sur ce que fait un projet, sa structure ou son fonctionnement, plutôt que de deviner depuis les noms de fichiers ou dossiers. Un seul appel va jusqu'au bout du dépôt entier (ça peut prendre un moment sur un gros dépôt — c'est normal, laisse-le terminer, ne t'arrête pas en cours de route et ne redemande pas confirmation à l'utilisateur avant la fin). Ensuite, utilise list_indexed_project_files et read_indexed_project_file pour explorer le contenu stocké. Ce n'est que dans le cas extrême d'un dépôt gigantesque (complete: false dans le résultat) qu'un second appel identique est utile pour continuer.",
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

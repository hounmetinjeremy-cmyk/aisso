import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listUserRepos, importRepoFiles, type ImportedFile } from '~/lib/github-import.server';
import { indexGithubProjectViaMcp, type McpFileContentsCaller } from '~/lib/.server/project-indexer-mcp.server';
import { readAllIndexedFiles } from '~/lib/.server/project-indexer.server';
import { FILE_READ_TOOL_NAME_PATTERN } from '~/lib/.server/llm/mcp-file-capture.server';
import { persistImportedFilesToSnapshot } from '~/lib/.server/llm/persist-imported-files.server';

/**
 * Outils "build mode" pour ouvrir un dépôt GitHub EXISTANT directement dans
 * l'éditeur au lieu de se contenter d'en parler. Avant l'ajout de ces
 * outils, aucun outil de ce nom n'existait réellement malgré un commentaire
 * dans github-import.server.ts qui en décrivait un ("import_github_repo") —
 * le modèle n'avait donc d'autre choix que de renvoyer l'utilisateur vers le
 * bouton "Importer" manuel, même quand on lui demandait explicitement
 * d'ouvrir/continuer un projet GitHub pour le déployer.
 *
 * Deux sources possibles pour import_github_repo, choisies automatiquement
 * selon ce qui est disponible pour l'utilisateur (jamais besoin des deux, ni
 * qu'il précise laquelle) — même logique que buildProjectIndexTools en mode
 * "discuss" (project-index-tools.ts) :
 * - githubToken (connexion GitHub "app") -> lecture REST directe
 *   (github-import.server.ts), la plus rapide.
 * - à défaut, un outil MCP de lecture de fichier déjà connecté par
 *   l'utilisateur (ex: "get_file_contents") -> même résultat, via
 *   l'indexation déterministe de project-indexer-mcp.server.ts (déjà
 *   utilisée par analyze_github_project en mode "discuss").
 *
 * Le contenu réel des fichiers est streamé directement au client (voir
 * Chat.client.tsx, écoute `data-import-files` -> workbenchStore.createFiles),
 * EXACTEMENT comme le bouton "Importer" manuel (useDeployToGitHub.client.ts)
 * — jamais recopié par le modèle via <boltAction>. Ça évite toute limite
 * liée à la fenêtre de sortie du modèle : le serveur écrit une fois, pour de
 * vrai, peu importe la taille du dépôt (dans les limites déjà appliquées par
 * importRepoFiles / indexGithubProjectViaMcp eux-mêmes).
 *
 * Le seul plafond qui reste ici (MODEL_CONTEXT_BUDGET_BYTES) ne protège que
 * le CONTEXTE DU MODÈLE, pas l'éditeur : au-delà, le modèle ne voit plus le
 * contenu textuel de chaque fichier pour raisonner dessus dans ce tour, mais
 * les fichiers sont déjà tous dans l'éditeur quoi qu'il arrive.
 */

const MODEL_CONTEXT_BUDGET_BYTES = 300_000;

// Fichiers de config/racine à privilégier en priorité dans le budget ci-dessus quand tout ne rentre pas.
const PRIORITY_FILENAME_PATTERN =
  /^(package\.json|wrangler\.toml|vite\.config\.\w+|next\.config\.\w+|netlify\.toml|vercel\.json|tsconfig\.json|README(\.\w+)?|\.env\.example|index\.html)$/i;

function pickFilesForModelContext(textFiles: ImportedFile[]) {
  const byPriority = [...textFiles].sort((a, b) => {
    const aPriority = PRIORITY_FILENAME_PATTERN.test(a.path.split('/').pop() ?? '') ? 0 : 1;
    const bPriority = PRIORITY_FILENAME_PATTERN.test(b.path.split('/').pop() ?? '') ? 0 : 1;

    return aPriority - bPriority;
  });

  const included: ImportedFile[] = [];
  let usedBytes = 0;

  for (const file of byPriority) {
    if (usedBytes + file.content.length > MODEL_CONTEXT_BUDGET_BYTES) {
      continue;
    }

    included.push(file);
    usedBytes += file.content.length;
  }

  return { included, contentTruncated: included.length < textFiles.length };
}

export function buildGithubImportTools(params: {
  githubToken: string | null;
  writer?: Pick<UIMessageStreamWriter, 'write'>;

  /** Outils MCP déjà connectés par l'utilisateur (mcpService.tools) — source de secours si pas de token "app". */
  mcpTools?: ToolSet;
  supabase: SupabaseClient | null;
  userId: string | null;
  chatId?: string | null;
}): ToolSet {
  const { githubToken, writer, mcpTools, supabase, userId, chatId } = params;

  const mcpFileTool = Object.entries(mcpTools ?? {}).find(
    ([toolName, toolDef]) => FILE_READ_TOOL_NAME_PATTERN.test(toolName) && typeof toolDef.execute === 'function',
  )?.[1];

  const canImportViaMcp = !!mcpFileTool && !!supabase && !!userId;

  if (!githubToken && !canImportViaMcp) {
    return {};
  }

  const callMcpTool: McpFileContentsCaller | null = mcpFileTool
    ? async (input) => mcpFileTool.execute!(input, { messages: [], toolCallId: 'github-import-tool' })
    : null;

  const tools: ToolSet = {
    import_github_repo: tool({
      description:
        'Ouvre un dépôt GitHub EXISTANT dans l\'éditeur pour le continuer/modifier/déployer (ex: "héberge mon projet X sur Cloudflare", "ouvre mon dépôt Y"). Fonctionne que l\'utilisateur ait connecté GitHub via le bouton "+" OU seulement un serveur MCP donnant accès au contenu des fichiers (get_file_contents ou équivalent) — la source est choisie automatiquement, tu n\'as pas à t\'en soucier. Place TOUS ses fichiers directement dans l\'éditeur automatiquement (quelle que soit la taille du dépôt) — tu n\'as PAS besoin de les réécrire toi-même via <boltAction>, ils apparaissent déjà. Le résultat te donne en plus le contenu texte des fichiers (dans la limite du contexte de ce tour, les fichiers de config/racine étant prioritaires) pour que tu puisses raisonner dessus et écrire seulement les <boltAction type="file"> des fichiers que tu CRÉES ou MODIFIES pour répondre à la demande. Ne dis jamais à l\'utilisateur d\'utiliser le bouton "Importer" manuel quand cet outil est disponible.',
      inputSchema: z.object({
        owner: z.string().describe('Propriétaire du dépôt GitHub (utilisateur ou organisation)'),
        repo: z.string().describe('Nom du dépôt'),
        branch: z
          .string()
          .describe('Branche à ouvrir (ex: main) — utilise list_my_github_repos si tu ne la connais pas'),
      }),
      execute: async ({ owner, repo, branch }) => {
        try {
          let files: { path: string; content: string; isBinary: boolean }[];
          let skipped = 0;
          let truncated = false;
          let viaMcpIncomplete = false;

          if (githubToken) {
            const result = await importRepoFiles(githubToken, { owner, repo, branch });
            files = result.files;
            skipped = result.skipped;
            truncated = result.truncated;
          } else {
            // Repli MCP : indexe (ou complète l'indexation existante) puis relit tout depuis Supabase.
            const indexResult = await indexGithubProjectViaMcp(supabase!, userId!, callMcpTool!, {
              owner,
              repo,
              branch,
            });
            viaMcpIncomplete = !indexResult.complete;

            const rows = await readAllIndexedFiles(supabase!, userId!, { owner, repo, branch });
            files = rows.map((row) => ({ path: row.path, content: row.content ?? '', isBinary: row.is_binary }));
          }

          const textFiles: ImportedFile[] = files.filter((f) => !f.isBinary);
          const binaryFiles = files.filter((f) => f.isBinary);

          /*
           * Place tout le dépôt dans l'éditeur immédiatement — jamais bloqué
           * par le budget de contexte ci-dessous. owner/repo/branch permet au
           * client de fixer aussi ce dépôt comme cible de push (voir
           * Chat.client.tsx) — sinon le push automatique de fin de tour
           * resterait sans cible malgré cet import.
           */
          writer?.write({
            type: 'data-import-files',
            data: { owner, repo, branch, files },
          });

          /*
           * Sauvegarde aussi directement côté serveur (voir
           * persist-imported-files.server.ts) : sans ça, si l'utilisateur
           * quitte l'app juste après cet import, rien de tout ce travail
           * n'est jamais sauvegardé (c'est normalement le navigateur qui
           * s'en charge, mais il n'en a pas forcément le temps).
           */
          if (supabase && userId && chatId) {
            persistImportedFilesToSnapshot(supabase, userId, chatId, files).catch(() => {});
          }

          const { included, contentTruncated } = pickFilesForModelContext(textFiles);

          return {
            message: `${files.length} fichier(s) importé(s) depuis ${owner}/${repo}@${branch}${githubToken ? '' : ' (via ton serveur MCP connecté)'} et placés dans l'éditeur (aucune réécriture de ta part nécessaire pour ces fichiers). ${
              viaMcpIncomplete
                ? "Dépôt volumineux : l'indexation via MCP n'a pas pu tout lire en un seul appel — rappelle import_github_repo avec le même owner/repo/branch pour continuer, les fichiers déjà lus resteront dans l'éditeur. "
                : ''
            }${
              contentTruncated
                ? `Contenu texte fourni ci-dessous pour ${included.length}/${textFiles.length} fichiers (les plus pertinents : config, package.json, README...) — le reste est dans l'éditeur mais pas reproduit ici, demande son contenu à l'utilisateur si besoin d'un fichier précis absent de la liste.`
                : `Contenu texte de tous les fichiers fourni ci-dessous.`
            } Écris uniquement des <boltAction type="file"> pour les fichiers que tu crées ou modifies.`,
            files: included.map((f) => ({ path: f.path, content: f.content })),
            allFilePaths: files.map((f) => f.path),
            binaryFilePaths: binaryFiles.map((f) => f.path),
            contentTruncated,
            viaMcpIncomplete,
            skipped,
            truncated,
          };
        } catch (error) {
          return {
            message: `Échec de l'import de ${owner}/${repo}@${branch} : ${error instanceof Error ? error.message : 'erreur inconnue'}. Vérifie le owner/repo/branch${githubToken ? ' (utilise list_my_github_repos)' : ''} et éventuellement réessaie. Si ça échoue à nouveau, propose à l'utilisateur le bouton d'action rapide décrit dans tes instructions système (<button data-bolt-quick-action="true" data-type="link" data-href="/select-repo">) au lieu d'une simple phrase — il pourra importer lui-même en un clic.`,
          };
        }
      },
    }),
  };

  /*
   * Sans token "app", aucune liste de dépôts fiable à offrir ici (le repli MCP n'a pas d'équivalent générique) —
   * le modèle utilise alors directement les outils MCP de l'utilisateur si son serveur en expose un.
   */
  if (githubToken) {
    tools.list_my_github_repos = tool({
      description:
        "Liste les dépôts GitHub de l'utilisateur (connexion GitHub \"app\", pas MCP). Utilise ceci pour retrouver le owner/repo/default branch exacts quand l'utilisateur nomme un projet sans donner ces détails précis, avant d'appeler import_github_repo.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const repos = await listUserRepos(githubToken);
          return { repos };
        } catch (error) {
          return {
            message: `Impossible de lister les dépôts : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    });
  }

  return tools;
}

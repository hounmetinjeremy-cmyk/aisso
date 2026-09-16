import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { listUserRepos, importRepoFiles, type ImportedFile } from '~/lib/github-import.server';

/**
 * Outils "build mode" pour ouvrir un dépôt GitHub EXISTANT directement dans
 * l'éditeur au lieu de se contenter d'en parler. Avant l'ajout de ces
 * outils, aucun outil de ce nom n'existait réellement malgré un commentaire
 * dans github-import.server.ts qui en décrivait un ("import_github_repo") —
 * le modèle n'avait donc d'autre choix que de renvoyer l'utilisateur vers le
 * bouton "Importer" manuel, même quand on lui demandait explicitement
 * d'ouvrir/continuer un projet GitHub pour le déployer.
 *
 * Le contenu réel des fichiers est streamé directement au client (voir
 * Chat.client.tsx, écoute `data-import-files` -> workbenchStore.createFiles),
 * EXACTEMENT comme le bouton "Importer" manuel (useDeployToGitHub.client.ts)
 * — jamais recopié par le modèle via <boltAction>. Ça évite toute limite
 * liée à la fenêtre de sortie du modèle : le serveur écrit une fois, pour de
 * vrai, peu importe la taille du dépôt (dans les limites déjà appliquées par
 * importRepoFiles lui-même : MAX_FILES/MAX_FILE_BYTES, propres au Worker).
 *
 * Le seul plafond qui reste ici (MODEL_CONTEXT_BUDGET_BYTES) ne protège que
 * le CONTEXTE DU MODÈLE, pas l'éditeur : au-delà, le modèle ne voit plus le
 * contenu textuel de chaque fichier pour raisonner dessus dans ce tour, mais
 * les fichiers sont déjà tous dans l'éditeur quoi qu'il arrive.
 *
 * Utilise le jeton de la connexion GitHub "app" (voir github-tools.ts),
 * jamais un token MCP — c'est la même source que le bouton "Importer" et
 * /api/deploy/import, pour un comportement identique.
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
}): ToolSet {
  const { githubToken, writer } = params;

  if (!githubToken) {
    return {};
  }

  return {
    list_my_github_repos: tool({
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
    }),
    import_github_repo: tool({
      description:
        'Ouvre un dépôt GitHub EXISTANT dans l\'éditeur pour le continuer/modifier/déployer (ex: "héberge mon projet X sur Cloudflare", "ouvre mon dépôt Y"). Place TOUS ses fichiers directement dans l\'éditeur automatiquement (quelle que soit la taille du dépôt) — tu n\'as PAS besoin de les réécrire toi-même via <boltAction>, ils apparaissent déjà. Le résultat te donne en plus le contenu texte des fichiers (dans la limite du contexte de ce tour, les fichiers de config/racine étant prioritaires) pour que tu puisses raisonner dessus et écrire seulement les <boltAction type="file"> des fichiers que tu CRÉES ou MODIFIES pour répondre à la demande. Ne dis jamais à l\'utilisateur d\'utiliser le bouton "Importer" manuel quand cet outil est disponible.',
      inputSchema: z.object({
        owner: z.string().describe('Propriétaire du dépôt GitHub (utilisateur ou organisation)'),
        repo: z.string().describe('Nom du dépôt'),
        branch: z
          .string()
          .describe('Branche à ouvrir (ex: main) — utilise list_my_github_repos si tu ne la connais pas'),
      }),
      execute: async ({ owner, repo, branch }) => {
        try {
          const result = await importRepoFiles(githubToken, { owner, repo, branch });

          const textFiles = result.files.filter((f) => !f.isBinary);
          const binaryFiles = result.files.filter((f) => f.isBinary);

          /*
           * Place tout le dépôt dans l'éditeur immédiatement — jamais bloqué
           * par le budget de contexte ci-dessous. owner/repo/branch permet au
           * client de fixer aussi ce dépôt comme cible de push (voir
           * Chat.client.tsx) — sinon le push automatique de fin de tour
           * resterait sans cible malgré cet import.
           */
          writer?.write({
            type: 'data-import-files',
            data: {
              owner,
              repo,
              branch,
              files: result.files.map((f) => ({ path: f.path, content: f.content, isBinary: f.isBinary })),
            },
          });

          const { included, contentTruncated } = pickFilesForModelContext(textFiles);

          return {
            message: `${result.files.length} fichier(s) importé(s) depuis ${owner}/${repo}@${branch} et placés dans l'éditeur (aucune réécriture de ta part nécessaire pour ces fichiers). ${
              contentTruncated
                ? `Contenu texte fourni ci-dessous pour ${included.length}/${textFiles.length} fichiers (les plus pertinents : config, package.json, README...) — le reste est dans l'éditeur mais pas reproduit ici, demande son contenu à l'utilisateur si besoin d'un fichier précis absent de la liste.`
                : `Contenu texte de tous les fichiers fourni ci-dessous.`
            } Écris uniquement des <boltAction type="file"> pour les fichiers que tu crées ou modifies.`,
            files: included.map((f) => ({ path: f.path, content: f.content })),
            allFilePaths: result.files.map((f) => f.path),
            binaryFilePaths: binaryFiles.map((f) => f.path),
            contentTruncated,
            skipped: result.skipped,
            truncated: result.truncated,
          };
        } catch (error) {
          return {
            message: `Échec de l'import de ${owner}/${repo}@${branch} : ${error instanceof Error ? error.message : 'erreur inconnue'}. Vérifie le owner/repo/branch (utilise list_my_github_repos), ou dis à l'utilisateur d'utiliser le bouton "Importer" manuel.`,
          };
        }
      },
    }),
  };
}

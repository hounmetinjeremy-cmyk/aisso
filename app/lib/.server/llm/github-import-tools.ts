import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { listUserRepos, importRepoFiles } from '~/lib/github-import.server';

/**
 * Outils "build mode" pour ouvrir un dépôt GitHub EXISTANT directement dans
 * l'éditeur (WorkbenchStore côté client, via boltAction) au lieu de se
 * contenter d'en parler. Avant l'ajout de ces outils, aucun outil de ce nom
 * n'existait réellement malgré un commentaire dans github-import.server.ts
 * qui en décrivait un ("import_github_repo") — le modèle n'avait donc
 * d'autre choix que de renvoyer l'utilisateur vers le bouton "Importer"
 * manuel, même quand on lui demandait explicitement d'ouvrir/continuer un
 * projet GitHub pour le déployer.
 *
 * Utilise le jeton de la connexion GitHub "app" (voir github-tools.ts),
 * jamais un token MCP — c'est la même source que le bouton "Importer" et
 * /api/deploy/import, pour un comportement identique.
 */

/*
 * Garde-fou distinct de MAX_FILES/MAX_FILE_BYTES (limites Worker) : combien de
 * contenu texte on peut raisonnablement redemander au modèle de recopier en
 * boltAction dans le même tour sans épuiser sa fenêtre de sortie.
 */
const MAX_INLINE_TOTAL_BYTES = 200_000;

export function buildGithubImportTools(params: { githubToken: string | null }): ToolSet {
  const { githubToken } = params;

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
        'Ouvre un dépôt GitHub EXISTANT dans l\'éditeur pour le continuer/modifier/déployer (ex: "héberge mon projet X sur Cloudflare", "ouvre mon dépôt Y"). Renvoie le contenu réel de tous ses fichiers texte. Une fois ce résultat reçu, réécris FIDÈLEMENT chaque fichier renvoyé via un <boltAction type="file"> dans le MÊME tour (contenu exact, aucune invention) avant d\'appliquer les changements demandés par l\'utilisateur — c\'est ce qui fait apparaître le projet dans l\'éditeur. Ne dis jamais à l\'utilisateur d\'utiliser le bouton "Importer" manuel quand cet outil est disponible.',
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
          const totalBytes = textFiles.reduce((sum, f) => sum + f.content.length, 0);

          if (totalBytes > MAX_INLINE_TOTAL_BYTES) {
            return {
              message: `${owner}/${repo}@${branch} contient ${result.files.length} fichier(s) pour ${totalBytes} octets de texte — trop volumineux pour être recopié fidèlement dans cette conversation. Dis à l'utilisateur d'utiliser le bouton "Importer" du panneau GitHub pour ce dépôt, qui n'a pas cette limite.`,
              tooLarge: true,
              fileCount: result.files.length,
              totalBytes,
            };
          }

          return {
            message: `${textFiles.length} fichier(s) texte lu(s) depuis ${owner}/${repo}@${branch}${
              binaryFiles.length > 0
                ? ` (+ ${binaryFiles.length} fichier(s) binaire(s) listé(s) mais non reproductible(s) en texte)`
                : ''
            }. Recopie chaque fichier ci-dessous EXACTEMENT via <boltAction type="file"> avant toute autre modification.`,
            files: textFiles.map((f) => ({ path: f.path, content: f.content })),
            binaryFilePaths: binaryFiles.map((f) => f.path),
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

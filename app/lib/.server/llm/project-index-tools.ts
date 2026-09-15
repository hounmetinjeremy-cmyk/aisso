import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  indexGithubProjectSequential,
  listIndexedFilePaths,
  readIndexedFile,
} from '~/lib/.server/project-indexer.server';

/**
 * Outils exposés au modèle pour comprendre en profondeur un dépôt GitHub
 * connecté — remplace le comportement précédent où seule la liste des noms
 * de fichiers était visible (via les outils MCP), jamais leur contenu. Voir
 * project-indexer.server.ts pour la lecture séquentielle + stockage.
 */
export function buildProjectIndexTools(params: {
  supabase: SupabaseClient | null;
  userId: string | null;
  githubToken: string | null;
}): ToolSet {
  const { supabase, userId, githubToken } = params;

  if (!supabase || !userId || !githubToken) {
    return {};
  }

  return {
    analyze_github_project: tool({
      description:
        "Indexe en profondeur un dépôt GitHub connecté : ouvre et lit le contenu COMPLET de chaque fichier pertinent un par un (jamais tout en mémoire d'un coup) et le stocke en base — à utiliser dès qu'une question porte sur ce que fait un projet, sa structure ou son fonctionnement, plutôt que de deviner depuis les noms de fichiers ou dossiers. Ensuite, utilise list_indexed_project_files et read_indexed_project_file pour explorer le contenu stocké.",
      inputSchema: z.object({
        owner: z.string().describe('Propriétaire du dépôt GitHub (utilisateur ou organisation)'),
        repo: z.string().describe('Nom du dépôt'),
        branch: z.string().describe('Branche à analyser (ex: main)'),
      }),
      execute: async ({ owner, repo, branch }) => {
        const result = await indexGithubProjectSequential(supabase, userId, githubToken, { owner, repo, branch });

        return {
          message: `Indexation terminée : ${result.filesIndexed} fichier(s) lu(s) et stocké(s) en base sur ${result.totalMatchingFiles} fichier(s) pertinent(s) trouvé(s)${
            result.filesSkippedByLimit > 0
              ? ` (${result.filesSkippedByLimit} fichier(s) supplémentaire(s) ignoré(s), limite atteinte — les fichiers les plus proches de la racine ont été priorisés)`
              : ''
          }. Utilise list_indexed_project_files pour voir la liste, puis read_indexed_project_file pour lire le contenu d'un fichier précis.`,
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

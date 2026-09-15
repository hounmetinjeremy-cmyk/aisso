import type { SupabaseClient } from '@supabase/supabase-js';
import ignore from 'ignore';
import { fetchBlob, listRepoTreeEntries } from '~/lib/github-import.server';
import { readFilesOneByOne, type SequentialProgress } from '~/lib/utils/sequential-file-reader';
import { IGNORE_PATTERNS } from './llm/constants';

/*
 * Un appel doit aller jusqu'au bout du dépôt sans s'arrêter en cours de
 * route pour attendre que l'utilisateur redemande — ce plafond n'est donc
 * PAS un "lot par appel" : c'est uniquement un garde-fou contre un dépôt
 * réellement pathologique (des dizaines de milliers de fichiers), pour que
 * même ce cas extrême reste borné dans le temps. Dans l'immense majorité des
 * projets (même gros), le dépôt filtré (voir IGNORE_PATTERNS) tient très
 * largement en dessous et l'indexation se termine donc toujours complète en
 * un seul appel. On privilégie quand même les fichiers les plus utiles à la
 * compréhension du projet (racine du dépôt, chemins courts) en premier, au
 * cas où ce plafond serait malgré tout atteint.
 */
const MAX_FILES_SAFETY_CEILING = 3000;

export interface IndexProjectParams {
  owner: string;
  repo: string;
  branch: string;
}

export interface IndexProjectResult {
  filesIndexed: number;
  filesSkippedBySize: number;
  filesAlreadyIndexed: number;
  filesRemaining: number;
  totalMatchingFiles: number;
  truncatedTree: boolean;
  complete: boolean;
}

/**
 * Indexation séquentielle et COMPLÈTE d'un dépôt GitHub dans Supabase en un
 * seul appel : 1) liste tous les chemins (un seul appel), 2) écarte ceux
 * déjà indexés (reprise automatique si un appel précédent s'est arrêté en
 * erreur en cours de route), 3) ouvre et lit le contenu complet de CHAQUE
 * fichier restant UN PAR UN (jamais plus d'un fichier en mémoire à la fois),
 * jusqu'à épuisement de la liste — pas de pause pour attendre une nouvelle
 * sollicitation, 4) stocke immédiatement ce contenu en base au fur et à
 * mesure — jamais un gros tableau de tout le dépôt accumulé en mémoire avant
 * d'écrire. `complete` dans le résultat n'est `false` que dans le cas
 * extrême où MAX_FILES_SAFETY_CEILING a été atteint.
 */
export async function indexGithubProjectSequential(
  supabase: SupabaseClient,
  userId: string,
  token: string,
  params: IndexProjectParams,
  onProgress?: (progress: SequentialProgress) => void,
): Promise<IndexProjectResult> {
  const { owner, repo, branch } = params;

  const [{ entries, skippedBySize, truncated }, alreadyIndexedPaths] = await Promise.all([
    listRepoTreeEntries(token, { owner, repo, branch }),
    listIndexedFilePaths(supabase, userId, { owner, repo, branch }),
  ]);

  const alreadyIndexed = new Set(alreadyIndexedPaths);
  const ig = ignore().add(IGNORE_PATTERNS);
  const matchingEntries = entries.filter((entry) => !ig.ignores(entry.path));
  const pendingEntries = matchingEntries.filter((entry) => !alreadyIndexed.has(entry.path));

  // Fichiers courts et proches de la racine d'abord (README, package.json, entrées principales, ...).
  const sortedEntries = [...pendingEntries].sort((a, b) => {
    const depthDiff = a.path.split('/').length - b.path.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.path.localeCompare(b.path);
  });

  const entriesToIndex = sortedEntries.slice(0, MAX_FILES_SAFETY_CEILING);
  const shaByPath = new Map(entriesToIndex.map((entry) => [entry.path, entry.sha]));
  const binaryByPath = new Map<string, boolean>();

  let filesIndexed = 0;

  await readFilesOneByOne(
    entriesToIndex.map((entry) => ({ path: entry.path })),
    async (file) => {
      const sha = shaByPath.get(file.path);

      if (!sha) {
        throw new Error(`sha manquant pour ${file.path}`);
      }

      const blob = await fetchBlob(token, owner, repo, { path: file.path, sha });

      if (!blob) {
        throw new Error(`Lecture impossible : ${file.path}`);
      }

      binaryByPath.set(file.path, blob.isBinary);

      return blob.content;
    },
    async (file, content) => {
      const { error } = await supabase.from('project_file_index').upsert(
        {
          user_id: userId,
          owner,
          repo,
          branch,
          path: file.path,
          content,
          is_binary: binaryByPath.get(file.path) ?? false,
          size: content.length,
          indexed_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,owner,repo,branch,path' },
      );

      if (error) {
        console.warn(`[project-indexer] échec stockage ${file.path}`, error);
        return;
      }

      filesIndexed++;
    },
    { pauseMs: 0, onProgress },
  );

  const filesRemaining = Math.max(0, sortedEntries.length - entriesToIndex.length);

  return {
    filesIndexed,
    filesSkippedBySize: skippedBySize,
    filesAlreadyIndexed: alreadyIndexed.size,
    filesRemaining,
    totalMatchingFiles: matchingEntries.length,
    truncatedTree: truncated,
    complete: filesRemaining === 0,
  };
}

export interface IndexedFileRow {
  path: string;
  content: string | null;
  is_binary: boolean;
  size: number;
  indexed_at: string;
}

/** Liste les chemins déjà indexés pour un dépôt (sans leur contenu — juste un manifeste). */
export async function listIndexedFilePaths(
  supabase: SupabaseClient,
  userId: string,
  params: IndexProjectParams,
): Promise<string[]> {
  const { owner, repo, branch } = params;

  const { data, error } = await supabase
    .from('project_file_index')
    .select('path')
    .eq('user_id', userId)
    .eq('owner', owner)
    .eq('repo', repo)
    .eq('branch', branch)
    .order('path', { ascending: true });

  if (error) {
    throw new Error(`Impossible de lister les fichiers indexés : ${error.message}`);
  }

  return (data ?? []).map((row) => row.path as string);
}

/** Lit le contenu déjà indexé d'un seul fichier (depuis Supabase, pas GitHub). */
export async function readIndexedFile(
  supabase: SupabaseClient,
  userId: string,
  params: IndexProjectParams & { path: string },
): Promise<IndexedFileRow | null> {
  const { owner, repo, branch, path } = params;

  const { data, error } = await supabase
    .from('project_file_index')
    .select('path, content, is_binary, size, indexed_at')
    .eq('user_id', userId)
    .eq('owner', owner)
    .eq('repo', repo)
    .eq('branch', branch)
    .eq('path', path)
    .maybeSingle();

  if (error) {
    throw new Error(`Impossible de lire le fichier indexé : ${error.message}`);
  }

  return (data as IndexedFileRow | null) ?? null;
}

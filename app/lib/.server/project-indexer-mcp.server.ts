import type { SupabaseClient } from '@supabase/supabase-js';
import ignore from 'ignore';
import { readFilesOneByOne, type SequentialProgress } from '~/lib/utils/sequential-file-reader';
import { IGNORE_PATTERNS } from './llm/constants';
import { extractMcpText, extractMcpFileContent } from './llm/mcp-content-parsing.server';
import { listIndexedFilePaths, type IndexProjectParams } from './project-indexer.server';

/**
 * Variante de project-indexer.server.ts qui n'a PAS besoin du jeton GitHub
 * "app" (connected_accounts) : elle pilote elle-même, de façon déterministe,
 * l'outil MCP de lecture de fichier ("get_file_contents" ou équivalent) que
 * l'utilisateur a déjà connecté — au lieu de compter sur le modèle pour
 * décider, tour après tour, d'ouvrir chaque fichier lui-même. Un modèle
 * rapide/économique suit rarement une longue consigne "n'arrête pas avant
 * d'avoir tout lu" ; cette fonction ne dépend d'aucune consigne, elle le
 * fait directement.
 *
 * Best-effort assumé (voir mcp-file-capture.server.ts) : la forme exacte de
 * l'outil dépend du serveur MCP tiers connecté par l'utilisateur. Ce module
 * suit la convention de l'API GitHub "contents" que la plupart des serveurs
 * MCP GitHub encapsulent directement : path='/' (ou un dossier) renvoie un
 * TABLEAU d'entrées {type: 'file'|'dir', path, size, ...} ; path=fichier
 * renvoie son contenu ({content, encoding} ou une chaîne brute).
 */

const MAX_FILES_SAFETY_CEILING = 3000;

/*
 * Garde-fou séparé contre un arbre de dossiers pathologique (ex: profondeur
 * ou largeur anormale) — indépendant du nombre de fichiers, puisqu'on visite
 * les dossiers un par un avant même de savoir combien de fichiers ils contiennent.
 */
const MAX_DIRECTORIES_SAFETY_CEILING = 2000;

export type McpFileContentsCaller = (input: {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}) => Promise<unknown>;

interface McpTreeEntry {
  path: string;
  type: 'file' | 'dir';
}

function normalizeDirPath(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/^\.+$/, '');
}

/*
 * Le paquet `ignore` lève une exception si le chemin n'est pas exactement
 * relatif (voir sa regex interne) — un chemin renvoyé par un serveur MCP
 * tiers dans une forme inattendue (vide, absolu, ".", etc.) ne doit jamais
 * faire planter toute l'indexation : en cas de doute, on considère juste le
 * fichier comme NON ignoré (fail-open) plutôt que de laisser l'exception remonter.
 */
function isIgnoredSafe(ig: ReturnType<typeof ignore>, relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  try {
    return ig.ignores(relativePath);
  } catch {
    return false;
  }
}

function parseDirectoryListing(raw: unknown): McpTreeEntry[] | null {
  const text = extractMcpText(raw);

  if (text === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const entries: McpTreeEntry[] = [];

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const obj = item as Record<string, unknown>;
    const path = typeof obj.path === 'string' ? obj.path : undefined;
    const rawType = obj.type;
    const type = rawType === 'dir' || rawType === 'directory' ? 'dir' : rawType === 'file' ? 'file' : undefined;

    if (!path || !type) {
      continue;
    }

    entries.push({ path, type });
  }

  return entries;
}

export interface IndexViaMcpResult {
  filesIndexed: number;
  filesAlreadyIndexed: number;
  filesRemaining: number;
  totalMatchingFiles: number;
  complete: boolean;
}

export async function indexGithubProjectViaMcp(
  supabase: SupabaseClient,
  userId: string,
  callTool: McpFileContentsCaller,
  params: IndexProjectParams,
  onProgress?: (progress: SequentialProgress) => void,
): Promise<IndexViaMcpResult> {
  const { owner, repo, branch } = params;
  const ig = ignore().add(IGNORE_PATTERNS);

  // Phase 1 : parcourt les dossiers (BFS) pour construire la liste des fichiers — sans jamais entrer dans un dossier ignoré.
  const files: McpTreeEntry[] = [];
  const dirQueue: string[] = ['/'];
  let dirsVisited = 0;

  while (dirQueue.length > 0 && dirsVisited < MAX_DIRECTORIES_SAFETY_CEILING) {
    const dirPath = dirQueue.shift()!;
    dirsVisited++;

    let listing: unknown;

    try {
      listing = await callTool({ owner, repo, path: dirPath, ref: branch });
    } catch (error) {
      console.warn(`[mcp-project-indexer] échec listing ${dirPath}`, error);
      continue;
    }

    const entries = parseDirectoryListing(listing);

    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      const relativePath = normalizeDirPath(entry.path);

      if (isIgnoredSafe(ig, relativePath)) {
        continue;
      }

      if (entry.type === 'dir') {
        dirQueue.push(entry.path);
      } else {
        files.push(entry);
      }
    }
  }

  // Phase 2 : écarte ce qui est déjà indexé, priorise la racine, plafonne, puis lit et stocke un par un.
  const alreadyIndexedPaths = await listIndexedFilePaths(supabase, userId, { owner, repo, branch });
  const alreadyIndexed = new Set(alreadyIndexedPaths);
  const pendingFiles = files.filter((file) => !alreadyIndexed.has(file.path));

  const sortedFiles = [...pendingFiles].sort((a, b) => {
    const depthDiff = a.path.split('/').length - b.path.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.path.localeCompare(b.path);
  });

  const filesToIndex = sortedFiles.slice(0, MAX_FILES_SAFETY_CEILING);
  const binaryByPath = new Map<string, boolean>();

  let filesIndexed = 0;

  await readFilesOneByOne(
    filesToIndex.map((file) => ({ path: file.path })),
    async (file) => {
      const raw = await callTool({ owner, repo, path: file.path, ref: branch });
      const parsed = extractMcpFileContent(raw);

      if (!parsed) {
        throw new Error(`Contenu illisible : ${file.path}`);
      }

      binaryByPath.set(file.path, parsed.isBinary);

      return parsed.content;
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
        console.warn(`[mcp-project-indexer] échec stockage ${file.path}`, error);
        return;
      }

      filesIndexed++;
    },
    { pauseMs: 0, onProgress },
  );

  const filesRemaining = Math.max(0, sortedFiles.length - filesToIndex.length);

  return {
    filesIndexed,
    filesAlreadyIndexed: alreadyIndexed.size,
    filesRemaining,
    totalMatchingFiles: files.length,
    complete: filesRemaining === 0,
  };
}

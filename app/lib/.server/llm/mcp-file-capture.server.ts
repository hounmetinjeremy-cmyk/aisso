import type { SupabaseClient } from '@supabase/supabase-js';
import { extractMcpFileContent } from './mcp-content-parsing.server';

/**
 * Quand aucune connexion GitHub "app" n'existe (voir project-index-tools.ts),
 * analyze_github_project reste indisponible et le modèle explore le dépôt
 * fichier par fichier via les outils du serveur MCP connecté par
 * l'utilisateur — sans jamais rien mémoriser, chaque lecture ne vivait que
 * dans cette conversation. Ce module capture, au vol, le résultat de tout
 * appel d'outil MCP qui RESSEMBLE à une lecture de contenu de fichier et le
 * stocke dans project_file_index au fur et à mesure — même table que
 * analyze_github_project, mêmes lectures suivantes possibles ensuite via
 * read_indexed_project_file, sans connexion supplémentaire.
 *
 * Best-effort assumé : le nom des outils et la forme exacte de leur résultat
 * dépendent du serveur MCP tiers connecté par l'utilisateur (pas de schéma
 * garanti). Toute étape qui ne correspond pas clairement à "lire un fichier"
 * est silencieusement ignorée plutôt que de risquer de stocker n'importe
 * quoi sous un mauvais chemin — ne doit jamais faire échouer le tour de chat.
 */

export const FILE_READ_TOOL_NAME_PATTERN = /get[_-]?file[_-]?contents?|read[_-]?file|file[_-]?content|get[_-]?blob/i;

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

export interface McpCapturedFile {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  isBinary: boolean;
}

/** Renvoie `null` dès que l'appel ne ressemble pas assez à une lecture de fichier exploitable — jamais d'exception. */
export function tryExtractMcpFileRead(toolName: string, input: unknown, output: unknown): McpCapturedFile | null {
  try {
    if (!FILE_READ_TOOL_NAME_PATTERN.test(toolName)) {
      return null;
    }

    if (typeof input !== 'object' || input === null) {
      return null;
    }

    const inputObj = input as Record<string, unknown>;
    const path = pickString(inputObj, ['path', 'file_path', 'filepath', 'filePath']);

    if (!path) {
      return null;
    }

    let owner = pickString(inputObj, ['owner', 'org', 'organization']);
    let repo = pickString(inputObj, ['repo', 'repository', 'repo_name']);

    if (!repo) {
      const combined = pickString(inputObj, ['full_name', 'fullName', 'repoFullName']);

      if (combined?.includes('/')) {
        const [combinedOwner, combinedRepo] = combined.split('/');
        owner = owner ?? combinedOwner;
        repo = combinedRepo;
      }
    }

    if (!owner && repo?.includes('/')) {
      const [splitOwner, splitRepo] = repo.split('/');
      owner = splitOwner;
      repo = splitRepo;
    }

    if (!repo) {
      return null;
    }

    const branch = pickString(inputObj, ['branch', 'ref']) ?? 'main';

    const extracted = extractMcpFileContent(output);

    if (!extracted) {
      return null;
    }

    return { owner: owner ?? repo, repo, branch, path, content: extracted.content, isBinary: extracted.isBinary };
  } catch {
    return null;
  }
}

export async function captureMcpFileRead(
  supabase: SupabaseClient,
  userId: string,
  file: McpCapturedFile,
): Promise<void> {
  const { error } = await supabase.from('project_file_index').upsert(
    {
      user_id: userId,
      owner: file.owner,
      repo: file.repo,
      branch: file.branch,
      path: file.path,
      content: file.content,
      is_binary: file.isBinary,
      size: file.content.length,
      indexed_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,owner,repo,branch,path' },
  );

  if (error) {
    console.warn(`[mcp-file-capture] échec stockage ${file.path}`, error);
  }
}

/**
 * Lit récursivement l'arbre Git d'un dépôt GitHub et renvoie le contenu de
 * ses fichiers texte — utilisé à la fois par la route /api/deploy/import
 * (bouton "Importer" manuel) et par l'outil IA import_github_repo (import
 * demandé en langage naturel dans le chat), pour ne pas dupliquer cette
 * logique entre les deux points d'entrée.
 */

const GITHUB_API = 'https://api.github.com';
const MAX_FILES = 400;
const MAX_FILE_BYTES = 250_000;

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Aisso-App',
  };
}

export interface ImportedFile {
  path: string;
  content: string;
}

export interface ImportResult {
  files: ImportedFile[];
  skipped: number;
  truncated: boolean;
}

export async function importRepoFiles(
  token: string,
  params: { owner: string; repo: string; branch: string },
): Promise<ImportResult> {
  const { owner, repo, branch } = params;

  const treeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
    headers: githubHeaders(token),
  });

  if (!treeRes.ok) {
    throw new Error(`Impossible de lire le dépôt ${owner}/${repo} (HTTP ${treeRes.status}).`);
  }

  const treeData = await treeRes.json<{
    truncated: boolean;
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  }>();

  const blobEntries = treeData.tree.filter((entry) => entry.type === 'blob' && (entry.size ?? 0) <= MAX_FILE_BYTES);

  if (blobEntries.length > MAX_FILES) {
    throw new Error(`Dépôt trop volumineux (${blobEntries.length} fichiers > ${MAX_FILES} max).`);
  }

  const skippedBySize = treeData.tree.length - blobEntries.length;

  const files = await Promise.all(
    blobEntries.map(async (entry): Promise<ImportedFile | null> => {
      const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${entry.sha}`, {
        headers: githubHeaders(token),
      });

      if (!blobRes.ok) {
        return null;
      }

      const blob = await blobRes.json<{ content: string; encoding: string }>();

      if (blob.encoding !== 'base64') {
        return null;
      }

      try {
        const binary = atob(blob.content.replace(/\n/g, ''));
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

        return { path: entry.path, content };
      } catch {
        // Décodage UTF-8 strict échoué : fichier binaire, ignoré pour cet import.
        return null;
      }
    }),
  );

  const textFiles = files.filter((file): file is ImportedFile => file !== null);

  return {
    files: textFiles,
    skipped: skippedBySize + (blobEntries.length - textFiles.length),
    truncated: treeData.truncated,
  };
}

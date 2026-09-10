/**
 * Lit récursivement l'arbre Git d'un dépôt GitHub et renvoie le contenu de
 * ses fichiers texte — utilisé à la fois par la route /api/deploy/import
 * (bouton "Importer" manuel) et par l'outil IA import_github_repo (import
 * demandé en langage naturel dans le chat), pour ne pas dupliquer cette
 * logique entre les deux points d'entrée.
 */

const GITHUB_API = 'https://api.github.com';

/*
 * Ces deux limites ne servent qu'a proteger le Worker Cloudflare lui-meme
 * (memoire, taille de reponse) — ce n'est pas un choix de contenu ("on
 * ignore les fichiers binaires"). Tous les fichiers texte ET binaires sont
 * desormais importes (voir isBinary plus bas) ; seuls les cas vraiment
 * extremes restent exclus.
 */
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 5_000_000;

/*
 * Un Worker Cloudflare est plafonne a 128 Mo de memoire (fixe, tous plans
 * confondus). Recuperer tous les blobs d'un depot via un seul Promise.all
 * les garde TOUS en memoire simultanement (reponses HTTP + buffers de
 * decodage) — pour un gros depot, ca peut depasser cette limite et faire
 * planter le Worker en plein import. En les traitant par petits lots, on ne
 * garde jamais plus que BATCH_SIZE fichiers "en vol" a la fois, quelle que
 * soit la taille totale du depot.
 */
const BATCH_SIZE = 20;

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

  /** true : `content` est le base64 tel que renvoye par l'API GitHub (fichier binaire). */
  isBinary: boolean;
}

export interface ImportResult {
  files: ImportedFile[];
  skipped: number;
  truncated: boolean;
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export async function listUserRepos(token: string): Promise<RepoSummary[]> {
  const res = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator',
    {
      headers: githubHeaders(token),
    },
  );

  if (!res.ok) {
    throw new Error(`Impossible de lister les dépôts (HTTP ${res.status}).`);
  }

  const repos =
    await res.json<
      Array<{ full_name: string; name: string; owner: { login: string }; default_branch: string; private: boolean }>
    >();

  return repos.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

async function fetchBlob(
  token: string,
  owner: string,
  repo: string,
  entry: { path: string; sha: string },
): Promise<ImportedFile | null> {
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

  const base64Content = blob.content.replace(/\n/g, '');

  try {
    const binary = atob(base64Content);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return { path: entry.path, content, isBinary: false };
  } catch {
    /*
     * Décodage UTF-8 strict échoué : fichier binaire (image, police, etc.).
     * On l'importe quand meme — GitHub renvoie deja son contenu en base64,
     * le meme format que FilesStore utilise pour les fichiers binaires (voir
     * FilesStore.createFile) — pas besoin de le decoder/reencoder, juste le
     * marquer comme tel.
     */
    return { path: entry.path, content: base64Content, isBinary: true };
  }
}

export async function importRepoFiles(
  token: string,
  params: { owner: string; repo: string; branch: string },

  /*
   * Appele apres chaque lot de BATCH_SIZE fichiers recuperes, avant de
   * passer au suivant — permet a l'appelant (voir /api/deploy/import) de
   * les ecrire immediatement quelque part (Supabase) sans attendre la fin
   * de tout l'import, et sans que cette fonction ait besoin de savoir ou.
   */
  onBatch?: (files: ImportedFile[]) => Promise<void>,
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

  const importedFiles: ImportedFile[] = [];
  let failedBlobFetches = 0;

  for (let i = 0; i < blobEntries.length; i += BATCH_SIZE) {
    const batchEntries = blobEntries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batchEntries.map((entry) => fetchBlob(token, owner, repo, entry)));
    const batchFiles = batchResults.filter((file): file is ImportedFile => file !== null);

    failedBlobFetches += batchEntries.length - batchFiles.length;

    if (onBatch && batchFiles.length > 0) {
      await onBatch(batchFiles);
    }

    importedFiles.push(...batchFiles);
  }

  /*
   * Ne compte que les fichiers ecartes par la taille ou par un echec
   * reseau/API isole sur leur blob — plus jamais a cause de leur type
   * (binaire), desormais toujours importe.
   */
  return {
    files: importedFiles,
    skipped: skippedBySize + failedBlobFetches,
    truncated: treeData.truncated,
  };
}

/**
 * Committe un ensemble de fichiers sur un dépôt GitHub en un seul commit, via
 * l'API Git Data (blobs -> tree -> commit -> update ref) — la même séquence
 * que l'ancien WorkbenchStore.pushToRepository (jamais branché à l'UI, mort
 * depuis le retrait du WebContainer), mais exécutée ici côté serveur avec le
 * jeton stocké dans Supabase plutôt que côté client avec un jeton en cookie.
 */

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Aisso-App',
  };
}

async function githubJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers as Record<string, string>) },
  });
  const raw = await res.text();
  let data: unknown = null;

  try {
    if (raw.trim()) {
      data = JSON.parse(raw);
    }
  } catch {
    // réponse non-JSON : on laisse data à null, le message d'erreur ci-dessous reste utile
  }

  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? `GitHub HTTP ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

export interface CommitFileInput {
  path: string;
  content: string;
}

export interface CommitResult {
  commitSha: string;
  commitUrl: string;
}

export async function commitFilesToRepo(
  token: string,
  params: { owner: string; repo: string; branch: string; message: string; files: CommitFileInput[] },
): Promise<CommitResult> {
  const { owner, repo, branch, message, files } = params;

  if (files.length === 0) {
    throw new Error('Aucun fichier à committer.');
  }

  // 1. Commit courant de la branche (sert de parent + base pour le nouvel arbre).
  let refSha: string;

  try {
    const ref = await githubJson<{ object: { sha: string } }>(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      token,
    );
    refSha = ref.object.sha;
  } catch {
    throw new Error(
      `Branche "${branch}" introuvable sur ${owner}/${repo}. Le dépôt doit déjà contenir au moins un commit (ex. un README) sur cette branche.`,
    );
  }

  const baseCommit = await githubJson<{ tree: { sha: string } }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${refSha}`,
    token,
  );

  // 2. Un blob par fichier.
  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await githubJson<{ sha: string }>(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      });
      return { path: file.path, sha: blob.sha };
    }),
  );

  // 3. Nouvel arbre basé sur l'arbre du commit courant + les fichiers modifiés/ajoutés.
  const tree = await githubJson<{ sha: string }>(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
    }),
  });

  // 4. Nouveau commit pointant sur ce nouvel arbre.
  const commit = await githubJson<{ sha: string; html_url: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [refSha] }),
    },
  );

  // 5. La branche pointe maintenant sur ce nouveau commit.
  await githubJson(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });

  return {
    commitSha: commit.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
  };
}

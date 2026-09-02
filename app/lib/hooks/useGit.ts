import { useCallback, useState } from 'react';
import Cookies from 'js-cookie';
import { toast } from 'react-toastify';

/**
 * Chargement de projet GitHub SANS git clone ni conteneur : utilise
 * directement l'API GitHub (Trees + Blobs), qui supporte le CORS et ne
 * necessite aucune infrastructure supplementaire (isomorphic-git et
 * webcontainer.fs sont totalement retires).
 *
 * Garde volontairement la MEME forme de retour qu'avant (workdir + data)
 * pour rester compatible avec le code appelant, sans devoir le modifier.
 */

const WORK_DIR = '/home/project';

function parseGithubUrl(url: string): { owner: string; repo: string; branch?: string } {
  let cleanUrl = url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');

  let branch: string | undefined;

  if (cleanUrl.includes('#')) {
    [cleanUrl, branch] = cleanUrl.split('#');
  }

  const [owner, repo] = cleanUrl.split('/');

  return { owner, repo, branch };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aisso',
  };

  const token = Cookies.get('githubToken');

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchDefaultBranch(owner: string, repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: githubHeaders() });

  if (!response.ok) {
    throw new Error(`Repository not found (${response.status})`);
  }

  const data = (await response.json()) as { default_branch: string };

  return data.default_branch;
}

interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

async function fetchTree(owner: string, repo: string, branch: string): Promise<GitTreeEntry[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: githubHeaders() },
  );

  if (!response.ok) {
    throw new Error(`Failed to load repository tree (${response.status})`);
  }

  const data = (await response.json()) as { tree: GitTreeEntry[]; truncated?: boolean };

  if (data.truncated) {
    toast.warning('Dépôt volumineux : certains fichiers pourraient être manquants.');
  }

  return data.tree.filter((entry) => entry.type === 'blob');
}

async function fetchBlob(owner: string, repo: string, sha: string): Promise<{ content: string; encoding: string }> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`, {
    headers: githubHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to load file blob (${response.status})`);
  }

  return response.json();
}

export function useGit() {
  const [ready] = useState(true);

  const gitClone = useCallback(async (url: string) => {
    try {
      const { owner, repo, branch: requestedBranch } = parseGithubUrl(url);

      if (!owner || !repo) {
        throw new Error('Invalid GitHub repository URL');
      }

      const branch = requestedBranch || (await fetchDefaultBranch(owner, repo));
      const entries = await fetchTree(owner, repo, branch);

      const data: Record<string, { data: any; encoding?: string }> = {};

      /*
       * Recupere les blobs en parallele par petits lots pour rester
       * raisonnable vis-a-vis des limites de taux de l'API GitHub.
       */
      const BATCH_SIZE = 10;

      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (entry) => {
            const blob = await fetchBlob(owner, repo, entry.sha);
            const relativePath = entry.path;

            if (blob.encoding === 'base64') {
              const binary = atob(blob.content.replace(/\n/g, ''));
              const bytes = new Uint8Array(binary.length);

              for (let j = 0; j < binary.length; j++) {
                bytes[j] = binary.charCodeAt(j);
              }

              // Heuristique simple texte/binaire : tente le decodage UTF-8.
              try {
                const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
                data[relativePath] = { data: text };
              } catch {
                data[relativePath] = { data: bytes, encoding: 'base64' };
              }
            } else {
              data[relativePath] = { data: blob.content };
            }
          }),
        );
      }

      return { workdir: WORK_DIR, data };
    } catch (error) {
      console.error('GitHub clone error:', error);

      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Impossible de charger le dépôt : ${message}`);

      throw error;
    }
  }, []);

  return { ready, gitClone };
}

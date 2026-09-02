import { useCallback, useState } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { chatId } from '~/lib/persistence';
import { WORK_DIR } from '~/utils/constants';
import { useAuth } from './useAuth.client';

export interface DeployRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface SelectedRepo {
  owner: string;
  repo: string;
  branch: string;
}

function repoStorageKey(id: string) {
  return `aisso:deploy-repo:${id}`;
}

/** Dépôt choisi pour ce chat lors d'un précédent déploiement, s'il y en a un. */
export function loadSelectedRepo(): SelectedRepo | null {
  const id = chatId.get();

  if (!id) {
    return null;
  }

  try {
    const raw = localStorage.getItem(repoStorageKey(id));
    return raw ? (JSON.parse(raw) as SelectedRepo) : null;
  } catch {
    return null;
  }
}

function saveSelectedRepo(repo: SelectedRepo) {
  const id = chatId.get();

  if (!id) {
    return;
  }

  localStorage.setItem(repoStorageKey(id), JSON.stringify(repo));
}

/**
 * Récupère l'état actuel des fichiers du projet (FilesStore, source de
 * vérité depuis le retrait du WebContainer) sous la forme attendue par
 * /api/deploy/commit : chemins relatifs au dépôt (sans le préfixe WORK_DIR),
 * fichiers texte uniquement.
 */
function collectProjectFiles(): { path: string; content: string }[] {
  const files = workbenchStore.files.get();
  const prefix = `${WORK_DIR}/`;
  const result: { path: string; content: string }[] = [];

  for (const [fullPath, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file' || dirent.isBinary) {
      continue;
    }

    const relativePath = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    result.push({ path: relativePath, content: dirent.content });
  }

  return result;
}

export function useDeployToGitHub() {
  const { user } = useAuth();
  const [repos, setRepos] = useState<DeployRepo[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchRepos = useCallback(async () => {
    if (!user) {
      return;
    }

    setLoadingRepos(true);

    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/deploy/repos', { headers: { Authorization: `Bearer ${idToken}` } });
      const data = await res.json<{ repos?: DeployRepo[]; error?: string }>();

      if (!res.ok) {
        throw new Error(data.error || 'Impossible de lister les dépôts.');
      }

      setRepos(data.repos ?? []);
    } finally {
      setLoadingRepos(false);
    }
  }, [user]);

  const deploy = useCallback(
    async (target: SelectedRepo, commitMessage?: string) => {
      if (!user) {
        throw new Error('Non connecté.');
      }

      const files = collectProjectFiles();

      if (files.length === 0) {
        throw new Error("Aucun fichier dans le projet actuel.");
      }

      setDeploying(true);

      try {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/deploy/commit', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...target, commitMessage, files }),
        });

        let data: { commitUrl?: string; commitSha?: string; error?: string };

        try {
          data = await res.json();
        } catch {
          throw new Error(`Réponse inattendue du serveur (HTTP ${res.status}).`);
        }

        if (!res.ok || !data.commitUrl) {
          throw new Error(data.error || 'Le commit a échoué.');
        }

        saveSelectedRepo(target);

        return data as { commitUrl: string; commitSha: string };
      } finally {
        setDeploying(false);
      }
    },
    [user],
  );

  const importRepo = useCallback(
    async (target: SelectedRepo) => {
      if (!user) {
        throw new Error('Non connecté.');
      }

      setImporting(true);

      try {
        const idToken = await user.getIdToken();
        const res = await fetch('/api/deploy/import', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(target),
        });

        let data: { files?: { path: string; content: string }[]; skipped?: number; error?: string };

        try {
          data = await res.json();
        } catch {
          throw new Error(`Réponse inattendue du serveur (HTTP ${res.status}).`);
        }

        if (!res.ok || !data.files) {
          throw new Error(data.error || "L'import a échoué.");
        }

        for (const file of data.files) {
          await workbenchStore.createFile(`${WORK_DIR}/${file.path}`, file.content);
        }

        saveSelectedRepo(target);

        return { importedCount: data.files.length, skipped: data.skipped ?? 0 };
      } finally {
        setImporting(false);
      }
    },
    [user],
  );

  return { repos, loadingRepos, fetchRepos, deploying, deploy, importing, importRepo };
}

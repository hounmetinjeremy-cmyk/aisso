import { useState } from 'react';
import { Link, useNavigate } from '@remix-run/react';
import { toast } from 'react-toastify';
import { GitHubRepositorySelector } from '~/components/@settings/tabs/github/components/GitHubRepositorySelector';
import { useDeployToGitHub } from '~/lib/hooks/useDeployToGitHub.client';

/**
 * Page affichée après connexion GitHub (OAuth MCP ou autre), et cible du
 * bouton d'action rapide de secours envoyé par l'IA quand elle n'a pas pu
 * importer un dépôt elle-même (voir github-import-tools.ts / prompts.ts) —
 * pour que l'utilisateur choisisse et importe le dépôt en un clic.
 *
 * Avant ce correctif, le clic ici ne faisait que rediriger vers `/` avec un
 * paramètre `importRepo` que rien ne lisait nulle part : aucun import ne se
 * produisait réellement. Fait maintenant le même import que le panneau
 * "+" (PlusToolsMenu.tsx/DeployPanel) — mêmes hooks, même mécanisme
 * (workbenchStore.createFiles + saveSelectedRepo côté import).
 */

/** cloneUrl est toujours "https://github.com/OWNER/REPO.git" (voir GitHubRepositorySelector). */
function parseCloneUrl(cloneUrl: string): { owner: string; repo: string } | null {
  const match = cloneUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export default function SelectRepoPage() {
  const { importRepo } = useDeployToGitHub();
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  const handleClone = async (cloneUrl: string, branch?: string) => {
    const parsed = parseCloneUrl(cloneUrl);

    if (!parsed || !branch) {
      toast.error('Dépôt ou branche invalide.');
      return;
    }

    setImporting(true);

    try {
      const { importedCount, skipped } = await importRepo({ owner: parsed.owner, repo: parsed.repo, branch });
      toast.success(
        `${importedCount} fichier${importedCount > 1 ? 's' : ''} importé${importedCount > 1 ? 's' : ''}` +
          (skipped > 0 ? ` (${skipped} ignoré${skipped > 1 ? 's' : ''}, binaires ou trop volumineux)` : ''),
      );
      navigate('/');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "L'import a échoué.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-bolt-elements-background-depth-1">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">Choisir un dépôt</h1>
            <p className="text-sm text-bolt-elements-textSecondary mt-1">
              Sélectionne le dépôt GitHub à ouvrir dans Aïsso.
            </p>
          </div>
          <Link
            to="/"
            className="text-sm px-3 py-1.5 rounded-lg border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2"
          >
            Plus tard
          </Link>
        </div>

        <div className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4 sm:p-6 relative">
          {importing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-bolt-elements-background-depth-2/80 rounded-xl text-sm text-bolt-elements-textSecondary">
              Import en cours…
            </div>
          )}
          <GitHubRepositorySelector onClone={handleClone} />
        </div>
      </div>
    </div>
  );
}

import { GitHubRepositorySelector } from '~/components/@settings/tabs/github/components/GitHubRepositorySelector';
import { Link } from '@remix-run/react';

/**
 * Page affichée après connexion GitHub (OAuth MCP ou autre)
 * pour que l'utilisateur choisisse le dépôt à ouvrir / importer.
 */
export default function SelectRepoPage() {
  const handleClone = (repoUrl: string, branch?: string) => {
    // Passe le dépôt choisi à l'app principale (query params)
    const params = new URLSearchParams();
    params.set('importRepo', repoUrl);
    if (branch) {
      params.set('branch', branch);
    }
    window.location.href = `/?${params.toString()}`;
  };

  return (
    <div className="min-h-screen bg-bolt-elements-background-depth-1">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">
              Choisir un dépôt
            </h1>
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

        <div className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4 sm:p-6">
          <GitHubRepositorySelector onClone={handleClone} />
        </div>
      </div>
    </div>
  );
}

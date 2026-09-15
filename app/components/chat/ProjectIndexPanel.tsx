import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAuth } from '~/lib/hooks/useAuth.client';
import { useMCPStore } from '~/lib/stores/mcp';

interface IndexResult {
  filesIndexed: number;
  filesAlreadyIndexed: number;
  filesRemaining: number;
  totalMatchingFiles: number;
  complete: boolean;
}

/**
 * Déclenche l'analyse en profondeur d'un dépôt directement, sans passer par
 * une décision de l'IA en chat — voir api.project-index.analyze.tsx. Ne
 * dépend PAS de connectedStatus.github (contrairement à DeployPanel juste
 * au-dessus) : fonctionne aussi bien avec une connexion GitHub "app" qu'avec
 * un outil MCP de lecture de fichier déjà connecté (ex: get_file_contents).
 */
export function ProjectIndexPanel() {
  const { user } = useAuth();
  const [ownerRepo, setOwnerRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<IndexResult | null>(null);

  const handleAnalyze = async () => {
    if (!user) {
      toast.error('Connecte-toi pour analyser un dépôt.');
      return;
    }

    const trimmed = ownerRepo.trim().replace(/^\/+|\/+$/g, '');
    const [owner, repo] = trimmed.split('/');

    if (!owner || !repo) {
      toast.error('Format attendu : proprietaire/depot (ex: hounmetinjeremy-cmyk/center)');
      return;
    }

    setAnalyzing(true);
    setResult(null);

    try {
      const idToken = await user.getIdToken();
      const mcpConfig = useMCPStore.getState().settings.mcpConfig;

      const res = await fetch('/api/project-index/analyze', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, branch: branch.trim() || 'main', mcpConfig }),
      });

      const data = await res.json<IndexResult & { error?: string }>();

      if (!res.ok) {
        throw new Error(data.error || `Échec de l'analyse (HTTP ${res.status}).`);
      }

      setResult(data);
      toast.success(
        `${data.filesIndexed} fichier${data.filesIndexed > 1 ? 's' : ''} indexé${data.filesIndexed > 1 ? 's' : ''}` +
          (data.complete ? ' — analyse complète.' : ` — ${data.filesRemaining} restant(s), relance pour continuer.`),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "L'analyse a échoué.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="pl-8 pr-3 py-2 mx-1 flex flex-col gap-2">
      <input
        type="text"
        placeholder="proprietaire/depot (ex: hounmetinjeremy-cmyk/center)"
        value={ownerRepo}
        onChange={(event) => setOwnerRepo(event.target.value)}
        className="w-full text-sm px-2.5 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      />
      <input
        type="text"
        placeholder="Branche (main)"
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        className="w-full text-sm px-2.5 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      />

      <button
        type="button"
        onClick={handleAnalyze}
        disabled={analyzing || !ownerRepo.trim()}
        className="text-sm font-medium px-3 py-1.5 rounded-md bg-purple-600 text-white hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {analyzing ? 'Analyse en cours…' : 'Analyser ce dépôt en profondeur'}
      </button>

      {result && (
        <div className="text-xs text-bolt-elements-textSecondary">
          {result.filesIndexed} fichier(s) lu(s) et stocké(s) sur {result.totalMatchingFiles} pertinent(s)
          {result.complete ? ' — terminé.' : ` — ${result.filesRemaining} restant(s), clique à nouveau pour continuer.`}
        </div>
      )}
    </div>
  );
}

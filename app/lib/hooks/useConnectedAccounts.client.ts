import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './useAuth.client';

export type OAuthProviderId = 'github' | 'vercel';

export interface ConnectedAccountsStatus {
  github: boolean;
  githubUsername: string | null;
  vercel: boolean;
  vercelTeamId: string | null;
}

const EMPTY_STATUS: ConnectedAccountsStatus = {
  github: false,
  githubUsername: null,
  vercel: false,
  vercelTeamId: null,
};

/**
 * Statut des comptes GitHub/Vercel connectés (backend centralisé), et point
 * d'entrée pour démarrer le flux OAuth : redirige le navigateur vers l'URL
 * d'autorisation renvoyée par /api/connect/:provider/start.
 */
export function useConnectedAccounts() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ConnectedAccountsStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<OAuthProviderId | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setStatus(EMPTY_STATUS);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/connect/status', { headers: { Authorization: `Bearer ${idToken}` } });

      if (res.ok) {
        setStatus(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (provider: OAuthProviderId) => {
      if (!user) {
        return;
      }

      setConnecting(provider);

      try {
        const idToken = await user.getIdToken();
        const res = await fetch(`/api/connect/${provider}/start`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });

        /*
         * La réponse est censée être du JSON dans tous les cas (succès ou
         * erreur), mais une exception non gérée côté serveur peut renvoyer
         * autre chose (page d'erreur générique) : on l'intercepte pour
         * afficher un message clair plutôt qu'une erreur de parsing brute.
         */
        let data: { url?: string; error?: string };

        try {
          data = await res.json<{ url?: string; error?: string }>();
        } catch {
          throw new Error(`Réponse inattendue du serveur (HTTP ${res.status}).`);
        }

        if (!res.ok || !data.url) {
          throw new Error(data.error || 'Impossible de démarrer la connexion.');
        }

        window.location.href = data.url;
      } catch (error) {
        setConnecting(null);
        throw error;
      }
    },
    [user],
  );

  return { status, loading, connecting, connect, refresh };
}

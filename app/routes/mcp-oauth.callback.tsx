import { useEffect, useState } from 'react';
import { useSearchParams, Link, useNavigate } from '@remix-run/react';
import { loadPendingOAuth, clearPendingOAuth, exchangeCodeForTokens, saveTokenMeta } from '~/lib/services/mcpOAuth';
import { useMCPStore } from '~/lib/stores/mcp';
import type { MCPConfig } from '~/lib/services/mcpService';

export default function McpOauthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Finalisation de la connexion…');
  const updateSettings = useMCPStore((s) => s.updateSettings);
  const settings = useMCPStore((s) => s.settings);
  const initialize = useMCPStore((s) => s.initialize);
  const isInitialized = useMCPStore((s) => s.isInitialized);

  useEffect(() => {
    if (!isInitialized) {
      void initialize();
    }
  }, [isInitialized, initialize]);

  useEffect(() => {
    if (!isInitialized) {
      return;
    }

    const run = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');
      const errorDescription = searchParams.get('error_description');

      if (error) {
        setStatus('error');
        setMessage(errorDescription || error || 'Autorisation refusée');
        clearPendingOAuth();

        return;
      }

      if (!code || !state) {
        setStatus('error');
        setMessage('Paramètres OAuth manquants (code ou state).');
        clearPendingOAuth();

        return;
      }

      const pending = loadPendingOAuth();

      if (!pending) {
        setStatus('error');
        setMessage('Session OAuth expirée. Recommencez depuis les paramètres MCP.');

        return;
      }

      if (pending.state !== state) {
        setStatus('error');
        setMessage('State OAuth invalide (possible attaque CSRF).');
        clearPendingOAuth();

        return;
      }

      if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
        setStatus('error');
        setMessage('Session OAuth expirée. Recommencez.');
        clearPendingOAuth();

        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, pending);

        if (!tokens.access_token) {
          throw new Error('Aucun access_token reçu');
        }

        if (tokens.refresh_token && pending.tokenEndpoint) {
          saveTokenMeta(pending.serverName, {
            refreshToken: tokens.refresh_token,
            tokenEndpoint: pending.tokenEndpoint,
            clientId: pending.clientId || 'aisso',
            clientSecret: pending.clientSecret,
            resource: pending.serverUrl,
            expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
          });
        }

        const existing = settings.mcpConfig.mcpServers[pending.serverName];

        if (!existing) {
          throw new Error(`Serveur MCP "${pending.serverName}" introuvable dans la config`);
        }

        const updatedServer = {
          ...existing,
          headers: {
            ...(existing as any).headers,
            Authorization: `Bearer ${tokens.access_token}`,
          },
        };

        const newConfig: MCPConfig = {
          mcpServers: {
            ...settings.mcpConfig.mcpServers,
            [pending.serverName]: updatedServer as any,
          },
        };

        await updateSettings({
          mcpConfig: newConfig,
          maxLLMSteps: settings.maxLLMSteps,
        });

        clearPendingOAuth();
        setStatus('success');
        setMessage(`Compte connecté pour « ${pending.serverName} ». Choisis maintenant un dépôt.`);

        // Redirection automatique vers la sélection de dépôt
        setTimeout(() => {
          navigate('/select-repo');
        }, 1500);
      } catch (e) {
        console.error('[mcp-oauth] callback error', e);
        setStatus('error');
        setMessage(e instanceof Error ? e.message : "Échec de l'échange du code OAuth");
        clearPendingOAuth();
      }
    };

    void run();
  }, [isInitialized, searchParams, settings, updateSettings, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bolt-elements-background-depth-1 p-4">
      <div className="max-w-md w-full rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6 shadow-lg text-center space-y-4">
        {status === 'loading' && (
          <>
            <div className="i-svg-spinners:90-ring-with-bg w-10 h-10 mx-auto text-bolt-elements-loader-progress animate-spin" />
            <p className="text-bolt-elements-textPrimary">{message}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="i-ph:check-circle w-12 h-12 mx-auto text-green-500" />
            <h1 className="text-lg font-semibold text-bolt-elements-textPrimary">Connexion réussie</h1>
            <p className="text-sm text-bolt-elements-textSecondary">{message}</p>
            <p className="text-xs text-bolt-elements-textTertiary">Redirection vers le choix du dépôt…</p>
            <Link
              to="/select-repo"
              className="inline-block mt-2 px-4 py-2 rounded-lg text-sm bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent"
            >
              Choisir un dépôt maintenant
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="i-ph:warning-circle w-12 h-12 mx-auto text-red-500" />
            <h1 className="text-lg font-semibold text-bolt-elements-textPrimary">Échec de la connexion</h1>
            <p className="text-sm text-bolt-elements-textSecondary">{message}</p>
            <Link
              to="/"
              className="inline-block mt-2 px-4 py-2 rounded-lg text-sm border border-bolt-elements-borderColor text-bolt-elements-textPrimary"
            >
              Retour aux paramètres
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

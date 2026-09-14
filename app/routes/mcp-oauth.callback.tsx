import { useEffect, useState } from 'react';
import { useSearchParams, Link } from '@remix-run/react';
import {
  loadPendingOAuth,
  clearPendingOAuth,
  exchangeCodeForTokens,
} from '~/lib/services/mcpOAuth';
import { useMCPStore } from '~/lib/stores/mcp';
import type { MCPConfig } from '~/lib/services/mcpService';

export default function McpOAuthCallback() {
  const [searchParams] = useSearchParams();
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

      // Expire after 15 minutes
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

        // Inject Authorization header into the MCP server config
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
        setMessage(`Compte connecté pour « ${pending.serverName} ». Vous pouvez fermer cette page.`);
      } catch (e) {
        console.error('[mcp-oauth] callback error', e);
        setStatus('error');
        setMessage(e instanceof Error ? e.message : 'Échec de l\'échange du code OAuth');
        clearPendingOAuth();
      }
    };

    void run();
  }, [isInitialized, searchParams, settings, updateSettings]);

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
            <Link
              to="/"
              className="inline-block mt-2 px-4 py-2 rounded-lg text-sm bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent"
            >
              Retour à Aïsso
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

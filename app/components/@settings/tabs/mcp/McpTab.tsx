import { useEffect, useMemo, useState } from 'react';
import { classNames } from '~/utils/classNames';
import type { MCPConfig } from '~/lib/services/mcpService';
import { toast } from 'react-toastify';
import { useMCPStore } from '~/lib/stores/mcp';
import McpServerList from '~/components/@settings/tabs/mcp/McpServerList';
import { startMcpOAuthFlow, clearTokenMeta } from '~/lib/services/mcpOAuth';

export default function McpTab() {
  const settings = useMCPStore((state) => state.settings);
  const isInitialized = useMCPStore((state) => state.isInitialized);
  const serverTools = useMCPStore((state) => state.serverTools);
  const initialize = useMCPStore((state) => state.initialize);
  const updateSettings = useMCPStore((state) => state.updateSettings);
  const checkServersAvailabilities = useMCPStore((state) => state.checkServersAvailabilities);

  const [isSaving, setIsSaving] = useState(false);
  const [maxLLMSteps, setMaxLLMSteps] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingServers, setIsCheckingServers] = useState(false);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [connectingServer, setConnectingServer] = useState<string | null>(null);

  const [newServerName, setNewServerName] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (!isInitialized) {
      initialize().catch((err) => {
        setError(`Failed to initialize MCP settings: ${err instanceof Error ? err.message : String(err)}`);
        toast.error('Failed to load MCP configuration');
      });
    }
  }, [isInitialized]);

  useEffect(() => {
    setMaxLLMSteps(settings.maxLLMSteps);
    setError(null);
  }, [settings]);

  const serverEntries = useMemo(() => Object.entries(serverTools), [serverTools]);

  const handleAddServer = async () => {
    const name = newServerName.trim();
    const url = newServerUrl.trim();

    if (!name) {
      setError('Le nom du serveur est requis.');
      return;
    }

    if (!url) {
      setError("L'URL du serveur est requise.");
      return;
    }

    try {
      new URL(url);
    } catch {
      setError("L'URL n'est pas valide.");
      return;
    }

    if (settings.mcpConfig.mcpServers[name]) {
      setError(`Un serveur nommé "${name}" existe déjà.`);
      return;
    }

    setIsAdding(true);
    setError(null);

    try {
      const newConfig: MCPConfig = {
        ...settings.mcpConfig,
        mcpServers: {
          ...settings.mcpConfig.mcpServers,
          [name]: {
            type: 'streamable-http',
            url,
          },
        },
      };

      await updateSettings({
        mcpConfig: newConfig,
        maxLLMSteps,
      });

      toast.success(`Connecteur "${name}" ajouté`);
      setNewServerName('');
      setNewServerUrl('');
      setExpandedServer(name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Échec de l'ajout du connecteur";
      setError(msg);
      toast.error(msg);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveServer = async (serverName: string) => {
    setIsSaving(true);
    setError(null);

    try {
      const { [serverName]: _, ...remaining } = settings.mcpConfig.mcpServers;

      await updateSettings({
        mcpConfig: { mcpServers: remaining },
        maxLLMSteps,
      });

      clearTokenMeta(serverName);
      toast.success(`Connecteur "${serverName}" supprimé`);

      if (expandedServer === serverName) {
        setExpandedServer(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Échec de la suppression';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnectAccount = async (serverName: string) => {
    const config = settings.mcpConfig.mcpServers[serverName] as any;

    if (!config?.url) {
      toast.error("Ce serveur n'a pas d'URL (stdio non supporté pour OAuth)");
      return;
    }

    setConnectingServer(serverName);
    setError(null);

    try {
      await startMcpOAuthFlow(serverName, config.url);

      /*
       * Sur l'app native, startMcpOAuthFlow ouvre le navigateur système
       * (Browser.open) et revient immédiatement — contrairement au web où
       * window.location.assign() ne rend jamais la main (la page navigue
       * ailleurs). Sans ça, le bouton resterait bloqué sur "Redirection
       * vers GitHub…" jusqu'au retour de l'app link (voir root.tsx), alors
       * que le navigateur système, lui, s'est bien ouvert.
       */
      setConnectingServer(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Impossible de démarrer OAuth';
      setError(msg);
      toast.error(msg);
      setConnectingServer(null);
    }
  };

  const handleSaveMaxSteps = async () => {
    setIsSaving(true);
    setError(null);

    try {
      await updateSettings({
        mcpConfig: settings.mcpConfig,
        maxLLMSteps,
      });
      toast.success('Paramètres sauvegardés');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Échec de la sauvegarde';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const checkServerAvailability = async () => {
    if (serverEntries.length === 0) {
      return;
    }

    setIsCheckingServers(true);
    setError(null);

    try {
      await checkServersAvailabilities();
    } catch (e) {
      setError(`Failed to check server availability: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsCheckingServers(false);
    }
  };

  const toggleServerExpanded = (serverName: string) => {
    setExpandedServer(expandedServer === serverName ? null : serverName);
  };

  const isServerConnected = (serverName: string) => {
    const cfg = settings.mcpConfig.mcpServers[serverName] as any;
    return Boolean(cfg?.headers?.Authorization);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <section aria-labelledby="add-connector-heading">
        <h2 id="add-connector-heading" className="text-base font-medium text-bolt-elements-textPrimary mb-3">
          Ajouter un connecteur MCP
        </h2>

        <div className="space-y-3 p-4 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1">
          <div>
            <label htmlFor="mcp-server-name" className="block text-sm text-bolt-elements-textSecondary mb-1.5">
              Nom
            </label>
            <input
              id="mcp-server-name"
              type="text"
              placeholder="ex: GitHub MCP"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-white dark:bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="mcp-server-url" className="block text-sm text-bolt-elements-textSecondary mb-1.5">
              URL du serveur
            </label>
            <input
              id="mcp-server-url"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={newServerUrl}
              onChange={(e) => setNewServerUrl(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-white dark:bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <p className="text-sm text-bolt-elements-icon-error">{error}</p>}

          <div className="flex justify-end pt-1">
            <button
              onClick={handleAddServer}
              disabled={isAdding || !newServerName.trim() || !newServerUrl.trim()}
              className={classNames(
                'px-4 py-2 rounded-lg text-sm flex items-center gap-2',
                'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent',
                'hover:bg-bolt-elements-item-backgroundActive',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {isAdding ? (
                <div className="i-svg-spinners:90-ring-with-bg w-4 h-4 animate-spin" />
              ) : (
                <div className="i-ph:plus w-4 h-4" />
              )}
              {isAdding ? 'Ajout…' : 'Ajouter le connecteur'}
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="server-status-heading">
        <div className="flex justify-between items-center mb-3">
          <h2 id="server-status-heading" className="text-base font-medium text-bolt-elements-textPrimary">
            Serveurs MCP configurés
          </h2>
          <button
            onClick={checkServerAvailability}
            disabled={isCheckingServers || serverEntries.length === 0}
            className={classNames(
              'px-3 py-1.5 rounded-lg text-sm',
              'bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-background-depth-4',
              'text-bolt-elements-textPrimary',
              'transition-all duration-200',
              'flex items-center gap-2',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isCheckingServers ? (
              <div className="i-svg-spinners:90-ring-with-bg w-3 h-3 text-bolt-elements-loader-progress animate-spin" />
            ) : (
              <div className="i-ph:arrow-counter-clockwise w-3 h-3" />
            )}
            Vérifier disponibilité
          </button>
        </div>

        <McpServerList
          checkingServers={isCheckingServers}
          expandedServer={expandedServer}
          serverEntries={serverEntries}
          toggleServerExpanded={toggleServerExpanded}
          onConnectAccount={handleConnectAccount}
          connectingServer={connectingServer}
          isServerConnected={isServerConnected}
          onRemoveServer={handleRemoveServer}
          removingServer={isSaving ? '__saving__' : null}
        />
      </section>

      <section aria-labelledby="advanced-heading">
        <h2 id="advanced-heading" className="text-base font-medium text-bolt-elements-textPrimary mb-3">
          Paramètres
        </h2>

        <div className="space-y-3">
          <div>
            <label htmlFor="max-llm-steps" className="block text-sm text-bolt-elements-textSecondary mb-1.5">
              Nombre maximum d'appels LLM séquentiels
            </label>
            <input
              id="max-llm-steps"
              type="number"
              min="1"
              max="20"
              value={maxLLMSteps}
              onChange={(e) => setMaxLLMSteps(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-white dark:bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSaveMaxSteps}
              disabled={isSaving}
              className={classNames(
                'px-4 py-2 rounded-lg text-sm flex items-center gap-2',
                'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent',
                'hover:bg-bolt-elements-item-backgroundActive',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <div className="i-ph:floppy-disk w-4 h-4" />
              {isSaving ? 'Sauvegarde…' : 'Sauvegarder'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

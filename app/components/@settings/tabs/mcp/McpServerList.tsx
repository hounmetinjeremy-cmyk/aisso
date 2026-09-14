import type { MCPServer } from '~/lib/services/mcpService';
import McpStatusBadge from '~/components/@settings/tabs/mcp/McpStatusBadge';
import { classNames } from '~/utils/classNames';

type McpServerListProps = {
  serverEntries: [string, MCPServer][];
  expandedServer: string | null;
  checkingServers: boolean;
  onlyShowAvailableServers?: boolean;
  toggleServerExpanded: (serverName: string) => void;
  onConnectAccount?: (serverName: string) => void;
  connectingServer?: string | null;
  isServerConnected?: (serverName: string) => boolean;
  onRemoveServer?: (serverName: string) => void;
  removingServer?: string | null;
};

function needsOAuth(error?: string): boolean {
  if (!error) {
    return false;
  }

  const lower = error.toLowerCase();

  return (
    lower.includes('invalid_token') ||
    lower.includes('jeton') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('access token') ||
    lower.includes('manquant') ||
    lower.includes('missing')
  );
}

export default function McpServerList({
  serverEntries,
  expandedServer,
  checkingServers,
  onlyShowAvailableServers = false,
  toggleServerExpanded,
  onConnectAccount,
  connectingServer,
  isServerConnected,
  onRemoveServer,
  removingServer,
}: McpServerListProps) {
  if (serverEntries.length === 0) {
    return <p className="text-sm text-bolt-elements-textSecondary">Aucun serveur MCP configuré</p>;
  }

  const filteredEntries = onlyShowAvailableServers
    ? serverEntries.filter(([, s]) => s.status === 'available')
    : serverEntries;

  return (
    <div className="space-y-4">
      {filteredEntries.map(([serverName, mcpServer]) => {
        const isAvailable = mcpServer.status === 'available';
        const isExpanded = expandedServer === serverName;
        const serverTools = isAvailable ? Object.entries(mcpServer.tools) : [];
        const hasUrl = mcpServer.config.type === 'sse' || mcpServer.config.type === 'streamable-http';
        const serverUrl = hasUrl ? ((mcpServer.config as any).url as string) : null;
        const connected = isServerConnected?.(serverName) ?? false;
        const initial = (serverName.trim()[0] || 'M').toUpperCase();

        const showConnect =
          hasUrl &&
          onConnectAccount &&
          (!connected || needsOAuth(mcpServer.status === 'unavailable' ? mcpServer.error : undefined) || !isAvailable);

        const toolNames = serverTools.map(([name]) => name);
        const visibleTools = toolNames.slice(0, 6);
        const moreCount = Math.max(0, toolNames.length - visibleTools.length);

        return (
          <div
            key={serverName}
            className="flex flex-col rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 overflow-hidden"
          >
            <div className="flex flex-col items-center px-4 pt-6 pb-4 gap-3">
              <div className="w-16 h-16 rounded-2xl bg-bolt-elements-background-depth-3 flex items-center justify-center text-2xl font-semibold text-bolt-elements-textSecondary">
                {initial}
              </div>
              <h3 className="text-lg font-semibold text-bolt-elements-textPrimary">{serverName}</h3>

              <div className="flex items-center gap-2">
                {checkingServers ? (
                  <McpStatusBadge status="checking" />
                ) : (
                  <McpStatusBadge status={isAvailable ? 'available' : 'unavailable'} />
                )}
                {connected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    Compte GitHub lié
                  </span>
                )}
              </div>

              {onRemoveServer && (
                <button
                  type="button"
                  onClick={() => onRemoveServer(serverName)}
                  disabled={removingServer === serverName || removingServer === '__saving__'}
                  className={classNames(
                    'w-full max-w-xs py-2.5 rounded-full text-sm font-medium',
                    'bg-black text-white dark:bg-white dark:text-black',
                    'hover:opacity-90 transition-opacity',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {removingServer === serverName || removingServer === '__saving__' ? 'Déconnexion…' : 'Déconnecter'}
                </button>
              )}
            </div>

            <div className="px-4 pb-3 space-y-3">
              <div>
                <p className="text-xs font-medium text-bolt-elements-textSecondary mb-1.5">Détails</p>
                <div className="rounded-xl bg-bolt-elements-background-depth-2 px-3 py-2.5">
                  <p className="text-[11px] text-bolt-elements-textSecondary mb-0.5">URL du serveur</p>
                  <p className="text-sm text-bolt-elements-textPrimary break-all">
                    {serverUrl ||
                      `${(mcpServer.config as any).command || ''} ${((mcpServer.config as any).args || []).join(' ')}`.trim() ||
                      '—'}
                  </p>
                </div>
              </div>

              {showConnect && (
                <div className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-2">
                  <p className="text-xs text-bolt-elements-textSecondary">
                    Ce serveur MCP nécessite une authentification GitHub pour lister et modifier tes dépôts.
                  </p>
                  <button
                    type="button"
                    onClick={() => onConnectAccount(serverName)}
                    disabled={connectingServer === serverName}
                    className={classNames(
                      'w-full py-2.5 rounded-full text-sm font-medium flex items-center justify-center gap-2',
                      'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent',
                      'hover:bg-bolt-elements-item-backgroundActive',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    {connectingServer === serverName ? (
                      <div className="i-svg-spinners:90-ring-with-bg w-4 h-4 animate-spin" />
                    ) : (
                      <div className="i-ph:github-logo w-4 h-4" />
                    )}
                    {connectingServer === serverName ? 'Redirection vers GitHub…' : 'Connecter le compte GitHub'}
                  </button>
                </div>
              )}

              {!isAvailable && mcpServer.error && (
                <p className="text-xs text-red-600 dark:text-red-400">Erreur : {mcpServer.error}</p>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => toggleServerExpanded(serverName)}
                  className="flex items-center justify-between w-full text-xs font-medium text-bolt-elements-textSecondary mb-1.5"
                >
                  <span>Outils {toolNames.length > 0 ? `(${toolNames.length})` : ''}</span>
                  <div className={`i-ph:${isExpanded ? 'caret-up' : 'caret-down'} w-3.5 h-3.5`} />
                </button>

                {toolNames.length === 0 ? (
                  <p className="text-xs text-bolt-elements-textSecondary px-1">
                    {isAvailable
                      ? 'Aucun outil disponible'
                      : 'Connecte ton compte GitHub puis vérifie la disponibilité pour charger les outils.'}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(isExpanded ? toolNames : visibleTools).map((name) => (
                      <span
                        key={name}
                        className="text-xs px-2.5 py-1 rounded-full bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary border border-bolt-elements-borderColor"
                      >
                        {name}
                      </span>
                    ))}
                    {!isExpanded && moreCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleServerExpanded(serverName)}
                        className="text-xs px-2.5 py-1 rounded-full text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                      >
                        Tout voir
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

import type { MCPServer } from '~/lib/services/mcpService';
import McpStatusBadge from '~/components/@settings/tabs/mcp/McpStatusBadge';
import McpServerListItem from '~/components/@settings/tabs/mcp/McpServerListItem';
import { classNames } from '~/utils/classNames';

type McpServerListProps = {
  serverEntries: [string, MCPServer][];
  expandedServer: string | null;
  checkingServers: boolean;
  onlyShowAvailableServers?: boolean;
  toggleServerExpanded: (serverName: string) => void;
  /** Called when user wants to start OAuth for a server that needs a token */
  onConnectAccount?: (serverName: string) => void;
  connectingServer?: string | null;
  /** Whether this server already has an Authorization header stored */
  isServerConnected?: (serverName: string) => boolean;
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
}: McpServerListProps) {
  if (serverEntries.length === 0) {
    return <p className="text-sm text-bolt-elements-textSecondary">Aucun serveur MCP configuré</p>;
  }

  const filteredEntries = onlyShowAvailableServers
    ? serverEntries.filter(([, s]) => s.status === 'available')
    : serverEntries;

  return (
    <div className="space-y-2">
      {filteredEntries.map(([serverName, mcpServer]) => {
        const isAvailable = mcpServer.status === 'available';
        const isExpanded = expandedServer === serverName;
        const serverTools = isAvailable ? Object.entries(mcpServer.tools) : [];
        const hasUrl =
          mcpServer.config.type === 'sse' || mcpServer.config.type === 'streamable-http';
        const connected = isServerConnected?.(serverName) ?? false;
        const showConnect =
          !isAvailable && hasUrl && onConnectAccount && (needsOAuth(mcpServer.error) || !connected);

        return (
          <div key={serverName} className="flex flex-col p-2 rounded-md bg-bolt-elements-background-depth-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div
                  onClick={() => toggleServerExpanded(serverName)}
                  className="flex items-center gap-1.5 text-bolt-elements-textPrimary cursor-pointer"
                  aria-expanded={isExpanded}
                >
                  <div
                    className={`i-ph:${isExpanded ? 'caret-down' : 'caret-right'} w-3 h-3 transition-transform duration-150`}
                  />
                  <span className="font-medium truncate text-left">{serverName}</span>
                </div>

                <div className="flex-1 min-w-0 truncate">
                  {hasUrl ? (
                    <span className="text-xs text-bolt-elements-textSecondary truncate">
                      {(mcpServer.config as any).url}
                    </span>
                  ) : (
                    <span className="text-xs text-bolt-elements-textSecondary truncate">
                      {(mcpServer.config as any).command} {(mcpServer.config as any).args?.join(' ')}
                    </span>
                  )}
                </div>
              </div>

              <div className="ml-2 flex-shrink-0 flex items-center gap-2">
                {connected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    Connecté
                  </span>
                )}
                {checkingServers ? (
                  <McpStatusBadge status="checking" />
                ) : (
                  <McpStatusBadge status={isAvailable ? 'available' : 'unavailable'} />
                )}
              </div>
            </div>

            {/* Error message */}
            {!isAvailable && mcpServer.error && (
              <div className="mt-1.5 ml-6 text-xs text-red-600 dark:text-red-400">Erreur : {mcpServer.error}</div>
            )}

            {/* CTA OAuth quand le token manque */}
            {showConnect && (
              <div className="mt-2 ml-6">
                <button
                  onClick={() => onConnectAccount(serverName)}
                  disabled={connectingServer === serverName}
                  className={classNames(
                    'text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5',
                    'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent',
                    'hover:bg-bolt-elements-item-backgroundActive',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {connectingServer === serverName ? (
                    <div className="i-svg-spinners:90-ring-with-bg w-3 h-3 animate-spin" />
                  ) : (
                    <div className="i-ph:github-logo w-3 h-3" />
                  )}
                  {connectingServer === serverName ? 'Redirection vers GitHub…' : 'Connecter le compte GitHub'}
                </button>
                <p className="mt-1 text-[11px] text-bolt-elements-textSecondary">
                  Ce serveur exige une authentification. Clique pour autoriser ton compte GitHub.
                </p>
              </div>
            )}

            {/* Tool list */}
            {isExpanded && isAvailable && (
              <div className="mt-2">
                <div className="text-bolt-elements-textSecondary text-xs font-medium ml-1 mb-1.5">Outils disponibles :</div>
                {serverTools.length === 0 ? (
                  <div className="ml-4 text-xs text-bolt-elements-textSecondary">Aucun outil disponible</div>
                ) : (
                  <div className="mt-1 space-y-2">
                    {serverTools.map(([toolName, toolSchema]) => (
                      <McpServerListItem
                        key={`${serverName}-${toolName}`}
                        toolName={toolName}
                        toolSchema={toolSchema}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

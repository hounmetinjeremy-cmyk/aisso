import { create } from 'zustand';
import type { MCPConfig, MCPServerTools } from '~/lib/services/mcpService';
import { getFreshAccessToken, loadTokenMeta } from '~/lib/services/mcpOAuth';

const MCP_SETTINGS_KEY = 'mcp_settings';
const isBrowser = typeof window !== 'undefined';

type MCPSettings = {
  mcpConfig: MCPConfig;
  maxLLMSteps: number;
};

const defaultSettings = {
  /*
   * Comprendre un projet en profondeur via des lectures MCP fichier par
   * fichier (quand analyze_github_project n'est pas disponible) prend
   * facilement plus de quelques appels d'outils (lister + lire chaque
   * fichier de chaque dossier) — une limite basse coupait le modèle après
   * seulement 3-4 fichiers, qui finissait par demander "veux-tu que je
   * continue ?" au lieu de simplement continuer. Fixé volontairement haut
   * (traité comme "illimité" en usage réel) : c'est un garde-fou contre une
   * boucle réellement infinie, pas un frein normal — voir aussi
   * MAX_FILES_SAFETY_CEILING dans project-indexer.server.ts, même logique.
   */
  maxLLMSteps: 500,
  mcpConfig: {
    mcpServers: {},
  },
} satisfies MCPSettings;

type Store = {
  isInitialized: boolean;
  settings: MCPSettings;
  serverTools: MCPServerTools;
  error: string | null;
  isUpdatingConfig: boolean;
};

type Actions = {
  initialize: () => Promise<void>;
  updateSettings: (settings: MCPSettings) => Promise<void>;
  checkServersAvailabilities: () => Promise<void>;
};

export const useMCPStore = create<Store & Actions>((set, get) => ({
  isInitialized: false,
  settings: defaultSettings,
  serverTools: {},
  error: null,
  isUpdatingConfig: false,
  initialize: async () => {
    if (get().isInitialized) {
      return;
    }

    if (isBrowser) {
      const savedConfig = localStorage.getItem(MCP_SETTINGS_KEY);

      if (savedConfig) {
        try {
          const settings = JSON.parse(savedConfig) as MCPSettings;
          const { serverTools, config } = await updateServerConfig(settings.mcpConfig);
          const finalSettings = { ...settings, mcpConfig: config };

          if (config !== settings.mcpConfig) {
            localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(finalSettings));
          }

          set(() => ({ settings: finalSettings, serverTools }));
        } catch (error) {
          console.error('Error parsing saved mcp config:', error);
          set(() => ({
            error: `Error parsing saved mcp config: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }
      } else {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(defaultSettings));
      }
    }

    set(() => ({ isInitialized: true }));
  },
  updateSettings: async (newSettings: MCPSettings) => {
    if (get().isUpdatingConfig) {
      return;
    }

    try {
      set(() => ({ isUpdatingConfig: true }));

      const { serverTools, config } = await updateServerConfig(newSettings.mcpConfig);
      const finalSettings = { ...newSettings, mcpConfig: config };

      if (isBrowser) {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(finalSettings));
      }

      set(() => ({ settings: finalSettings, serverTools }));
    } catch (error) {
      throw error;
    } finally {
      set(() => ({ isUpdatingConfig: false }));
    }
  },
  checkServersAvailabilities: async () => {
    const { serverTools, config } = await updateServerConfig(get().settings.mcpConfig);
    const finalSettings = { ...get().settings, mcpConfig: config };

    if (isBrowser) {
      localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(finalSettings));
    }

    set(() => ({ settings: finalSettings, serverTools }));
  },
}));

async function pushConfig(config: MCPConfig): Promise<MCPServerTools> {
  const response = await fetch('/api/mcp-update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as MCPServerTools;
}

function looksLikeAuthError(error?: string): boolean {
  if (!error) {
    return false;
  }

  const lower = error.toLowerCase();

  return (
    lower.includes('invalid_token') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('access token') ||
    lower.includes('jeton')
  );
}

/**
 * Pousse la config au serveur. Si un serveur OAuth revient "unavailable"
 * avec une erreur qui ressemble à un jeton invalide/expiré et qu'on a un
 * refresh_token stocké pour lui, tente un rafraîchissement silencieux puis
 * repousse la config une seule fois (pas de boucle si le refresh_token est
 * lui-même révoqué — dans ce cas l'UI proposera une reconnexion manuelle).
 */
async function updateServerConfig(config: MCPConfig): Promise<{ serverTools: MCPServerTools; config: MCPConfig }> {
  const serverTools = await pushConfig(config);

  const serversToRetry = Object.entries(serverTools).filter(
    ([serverName, server]) =>
      server.status === 'unavailable' &&
      looksLikeAuthError((server as { error?: string }).error) &&
      Boolean(loadTokenMeta(serverName)?.refreshToken),
  );

  if (serversToRetry.length === 0) {
    return { serverTools, config };
  }

  const updatedServers = { ...config.mcpServers };
  let anyRefreshed = false;

  await Promise.all(
    serversToRetry.map(async ([serverName]) => {
      try {
        const newToken = await getFreshAccessToken(serverName, { force: true });

        if (newToken) {
          const serverConfig = updatedServers[serverName] as any;
          updatedServers[serverName] = {
            ...serverConfig,
            headers: { ...serverConfig.headers, Authorization: `Bearer ${newToken}` },
          };
          anyRefreshed = true;
        }
      } catch (e) {
        console.warn(`[mcp] token refresh failed for "${serverName}"`, e);
      }
    }),
  );

  if (!anyRefreshed) {
    return { serverTools, config };
  }

  const refreshedConfig: MCPConfig = { ...config, mcpServers: updatedServers };
  const refreshedServerTools = await pushConfig(refreshedConfig);

  return { serverTools: refreshedServerTools, config: refreshedConfig };
}

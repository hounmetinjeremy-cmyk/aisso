import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { IconButton } from '~/components/ui/IconButton';
import { ColorSchemeDialog } from '~/components/ui/ColorSchemeDialog';
import { McpTools } from './MCPTools';
import { WebSearch } from './WebSearch.client';
import { SupabaseConnection } from './SupabaseConnection';
import { useConnectedAccounts, type OAuthProviderId, type ConnectedAccountsStatus } from '~/lib/hooks/useConnectedAccounts.client';
import type { DesignScheme } from '~/types/design-scheme';

const PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  github: 'GitHub',
  vercel: 'Vercel',
};

const PROVIDER_ICONS: Record<OAuthProviderId, string> = {
  github: 'i-ph:github-logo-fill',
  vercel: 'i-ph:triangle-fill',
};

/*
 * Statut + bouton "Connecter" pour un fournisseur OAuth (GitHub/Vercel), au
 * même endroit que les autres connecteurs (MCP, Supabase) dans ce menu, à la
 * manière du panneau "Ajouter au chat" de Claude qui liste tous les
 * connecteurs à un seul endroit.
 */
interface ConnectorRowProps {
  provider: OAuthProviderId;
  status: ConnectedAccountsStatus;
  loading: boolean;
  connecting: OAuthProviderId | null;
  connect: (provider: OAuthProviderId) => Promise<void>;
  onClose: () => void;
}

function ConnectorRow({ provider, status, loading, connecting, connect, onClose }: ConnectorRowProps) {
  const isConnected = provider === 'github' ? status.github : status.vercel;
  const label = provider === 'github' && status.githubUsername ? `@${status.githubUsername}` : PROVIDER_LABELS[provider];

  const handleConnect = () => {
    connect(provider)
      .then(() => onClose())
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Connexion impossible.');
      });
  };

  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
      <div className={classNames(PROVIDER_ICONS[provider], 'text-lg')} />
      <span>{label}</span>
      <div className="ml-auto">
        {isConnected ? (
          <span className="flex items-center gap-1 text-green-600 dark:text-green-400 text-xs">
            <span className="i-ph:check-circle-fill" />
            Connecté
          </span>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={loading || connecting === provider}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-colors disabled:opacity-60"
          >
            {connecting === provider ? 'Connexion...' : 'Connecter'}
          </button>
        )}
      </div>
    </div>
  );
}

interface PlusToolsMenuProps {
  onUploadFile: () => void;
  designScheme?: DesignScheme;
  setDesignScheme?: (scheme: DesignScheme) => void;
  onWebSearchResult: (result: string) => void;
  webSearchDisabled?: boolean;
  canEnhance: boolean;
  enhancingPrompt?: boolean;
  onEnhancePrompt: () => void;
  chatStarted: boolean;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
}

/*
 * Regroupe tous les outils secondaires (pièce jointe, palette, MCP, recherche web,
 * amélioration de prompt, mode discussion, Supabase) derrière un seul bouton "+",
 * comme le fait l'app Claude ("Ajouter au chat") — au lieu de les étaler en rangée
 * à côté du champ de saisie.
 */
export function PlusToolsMenu(props: PlusToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    status: connectedStatus,
    loading: connectedLoading,
    connecting: connectingProvider,
    connect: connectProvider,
    refresh: refreshConnectedAccounts,
  } = useConnectedAccounts();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);

    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // Après le retour du callback OAuth (?connected=github ou ?connect_error=...) :
  // notifie l'utilisateur, rafraîchit le statut, puis nettoie l'URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const connectError = params.get('connect_error');

    if (!connected && !connectError) {
      return;
    }

    if (connected) {
      toast.success(`${PROVIDER_LABELS[connected as OAuthProviderId] ?? connected} connecté avec succès.`);
      void refreshConnectedAccounts();
    } else if (connectError) {
      toast.error(`Connexion échouée : ${connectError}`);
    }

    params.delete('connected');
    params.delete('connect_error');

    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
    window.history.replaceState({}, '', next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => setOpen(false);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <IconButton title="Ajouter au chat" className="rounded-full !p-2 shrink-0" onClick={() => setOpen(!open)}>
        <div className={classNames('text-lg', open ? 'i-ph:x-bold' : 'i-ph:plus-bold')} />
      </IconButton>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 min-w-[220px] py-1.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg z-50 flex flex-col gap-0.5">
          <button
            type="button"
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1"
            onClick={() => {
              props.onUploadFile();
              close();
            }}
          >
            <div className="i-ph:paperclip text-lg" />
            <span>Importer un fichier</span>
          </button>

          <button
            type="button"
            disabled={!props.canEnhance}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              props.onEnhancePrompt();
              toast.success('Prompt enhanced!');
              close();
            }}
          >
            {props.enhancingPrompt ? (
              <div className="i-svg-spinners:90-ring-with-bg text-lg animate-spin" />
            ) : (
              <div className="i-bolt:stars text-lg" />
            )}
            <span>Améliorer le prompt</span>
          </button>

          {props.chatStarted && (
            <button
              type="button"
              className={classNames(
                'flex items-center gap-2.5 px-3 py-2 text-sm rounded-md mx-1 hover:bg-bolt-elements-item-backgroundActive',
                props.chatMode === 'discuss'
                  ? 'text-bolt-elements-item-contentAccent'
                  : 'text-bolt-elements-textPrimary',
              )}
              onClick={() => {
                props.setChatMode?.(props.chatMode === 'discuss' ? 'build' : 'discuss');
                close();
              }}
            >
              <div className="i-ph:chats text-lg" />
              <span>Mode discussion</span>
              {props.chatMode === 'discuss' && <div className="i-ph:check-bold text-sm ml-auto" />}
            </button>
          )}

          <div className="h-px bg-bolt-elements-borderColor my-1 mx-2" />

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:palette text-lg" />
            <span>Palette de couleurs</span>
            <div className="ml-auto">
              <ColorSchemeDialog designScheme={props.designScheme} setDesignScheme={props.setDesignScheme} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:plugs-connected text-lg" />
            <span>Outils MCP</span>
            <div className="ml-auto">
              <McpTools />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:globe text-lg" />
            <span>Recherche Web</span>
            <div className="ml-auto">
              <WebSearch onSearchResult={props.onWebSearchResult} disabled={props.webSearchDisabled} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:database text-lg" />
            <span>Supabase</span>
            <div className="ml-auto">
              <SupabaseConnection />
            </div>
          </div>

          <div className="h-px bg-bolt-elements-borderColor my-1 mx-2" />

          <ConnectorRow
            provider="github"
            status={connectedStatus}
            loading={connectedLoading}
            connecting={connectingProvider}
            connect={connectProvider}
            onClose={close}
          />
          <ConnectorRow
            provider="vercel"
            status={connectedStatus}
            loading={connectedLoading}
            connecting={connectingProvider}
            connect={connectProvider}
            onClose={close}
          />
        </div>
      )}
    </div>
  );
}

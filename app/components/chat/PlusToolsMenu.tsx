import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { IconButton } from '~/components/ui/IconButton';
import { ColorSchemeDialog } from '~/components/ui/ColorSchemeDialog';
import { McpTools } from './MCPTools';
import { WebSearch } from './WebSearch.client';
import { SupabaseConnection } from './SupabaseConnection';
import {
  useConnectedAccounts,
  type OAuthProviderId,
  type ConnectedAccountsStatus,
} from '~/lib/hooks/useConnectedAccounts.client';
import { useDeployToGitHub, loadSelectedRepo, type SelectedRepo } from '~/lib/hooks/useDeployToGitHub.client';
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
  disconnect: (provider: OAuthProviderId) => Promise<void>;
  onClose: () => void;
}

const LONG_PRESS_MS = 500;
const DISCONNECT_CONFIRM_TIMEOUT_MS = 4000;

function ConnectorRow({ provider, status, loading, connecting, connect, disconnect, onClose }: ConnectorRowProps) {
  const isConnected = provider === 'github' ? status.github : status.vercel;
  const label =
    provider === 'github' && status.githubUsername ? `@${status.githubUsername}` : PROVIDER_LABELS[provider];

  // Appui long sur "Connecté" pour révéler "Déconnecter" (évite une déconnexion accidentelle sur un simple tap).
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
      }

      if (confirmTimeout.current) {
        clearTimeout(confirmTimeout.current);
      }
    };
  }, []);

  const handleConnect = () => {
    connect(provider)
      .then(() => onClose())
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Connexion impossible.');
      });
  };

  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => {
      setConfirmingDisconnect(true);

      confirmTimeout.current = setTimeout(() => setConfirmingDisconnect(false), DISCONNECT_CONFIRM_TIMEOUT_MS);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleDisconnect = () => {
    setDisconnecting(true);
    disconnect(provider)
      .then(() => {
        toast.success(`${PROVIDER_LABELS[provider]} déconnecté.`);
        setConfirmingDisconnect(false);
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Déconnexion impossible.');
      })
      .finally(() => setDisconnecting(false));
  };

  return (
    <div className="flex items-center gap-2.5 pl-8 pr-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
      <div className={classNames(PROVIDER_ICONS[provider], 'text-lg')} />
      <span>{label}</span>
      <div className="ml-auto">
        {isConnected ? (
          confirmingDisconnect ? (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors disabled:opacity-60"
            >
              {disconnecting ? 'Déconnexion...' : 'Déconnecter'}
            </button>
          ) : (
            <span
              className="flex items-center gap-1 text-green-600 dark:text-green-400 text-xs select-none cursor-pointer"
              title="Appui long pour déconnecter"
              onPointerDown={startLongPress}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onPointerCancel={cancelLongPress}
            >
              <span className="i-ph:check-circle-fill" />
              Connecté
            </span>
          )
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

/*
 * Deux sens possibles avec un dépôt GitHub choisi par l'utilisateur :
 * - Importer : charge les fichiers d'un dépôt existant dans le projet en
 *   cours (pour reprendre un projet déjà sur GitHub).
 * - Committer & déployer : envoie l'état actuel des fichiers du projet vers
 *   le dépôt — remplace l'exécution locale (WebContainer désactivé) par un
 *   commit fait côté serveur avec le jeton GitHub stocké. Si le projet
 *   Vercel de l'utilisateur est lié nativement à ce dépôt, ce commit
 *   déclenche automatiquement un déploiement Vercel, sans appel direct à
 *   l'API Vercel.
 */
function DeployPanel({ onClose }: { onClose: () => void }) {
  const { repos, loadingRepos, fetchRepos, deploying, deploy, importing, importRepo } = useDeployToGitHub();
  const [selected, setSelected] = useState<SelectedRepo | null>(() => loadSelectedRepo());
  const [result, setResult] = useState<{ commitUrl: string } | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      void fetchRepos();
    }
  }, [fetchRepos]);

  const handleSelectChange = (fullName: string) => {
    const repo = repos?.find((r) => r.fullName === fullName);

    if (repo) {
      setSelected({ owner: repo.owner, repo: repo.name, branch: repo.defaultBranch });
      setResult(null);
    }
  };

  const handleImport = () => {
    if (!selected) {
      return;
    }

    importRepo(selected)
      .then(({ importedCount, skipped }) => {
        toast.success(
          `${importedCount} fichier${importedCount > 1 ? 's' : ''} importé${importedCount > 1 ? 's' : ''}` +
            (skipped > 0 ? ` (${skipped} ignoré${skipped > 1 ? 's' : ''}, binaires ou trop volumineux)` : ''),
        );
        onClose();
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "L'import a échoué.");
      });
  };

  const handleDeploy = () => {
    if (!selected) {
      return;
    }

    deploy(selected)
      .then((res) => {
        setResult(res);
        toast.success('Fichiers committés sur GitHub.');
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Le déploiement a échoué.');
      });
  };

  return (
    <div className="pl-8 pr-3 py-2 mx-1 flex flex-col gap-2">
      {loadingRepos && !repos ? (
        <div className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary">
          <div className="i-svg-spinners:90-ring-with-bg text-base" />
          Chargement des dépôts...
        </div>
      ) : (
        <select
          className="w-full text-sm px-2.5 py-1.5 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
          value={selected ? `${selected.owner}/${selected.repo}` : ''}
          onChange={(event) => handleSelectChange(event.target.value)}
        >
          <option value="" disabled>
            Choisir un dépôt...
          </option>
          {repos?.map((repo) => (
            <option key={repo.fullName} value={repo.fullName}>
              {repo.fullName}
            </option>
          ))}
        </select>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleImport}
          disabled={!selected || importing || deploying}
          className="flex-1 text-sm font-medium px-3 py-1.5 rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importing ? 'Import...' : 'Importer'}
        </button>

        <button
          type="button"
          onClick={handleDeploy}
          disabled={!selected || deploying || importing}
          className="flex-1 text-sm font-medium px-3 py-1.5 rounded-md bg-purple-600 text-white hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {deploying ? 'Envoi...' : 'Committer & déployer'}
        </button>
      </div>

      {result && (
        <a
          href={result.commitUrl}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className="text-xs text-purple-700 dark:text-purple-300 underline"
        >
          Voir le commit sur GitHub
        </a>
      )}
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
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    status: connectedStatus,
    loading: connectedLoading,
    connecting: connectingProvider,
    connect: connectProvider,
    disconnect: disconnectProvider,
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

  /*
   * Après le retour du callback OAuth (?connected=github ou ?connect_error=...) :
   * notifie l'utilisateur, rafraîchit le statut, puis nettoie l'URL.
   */
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

          {connectedStatus.github && (
            <>
              <div className="h-px bg-bolt-elements-borderColor my-1 mx-2" />

              <button
                type="button"
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1"
                onClick={() => setDeployOpen((v) => !v)}
              >
                <div className="i-ph:rocket-launch text-lg" />
                <span>GitHub</span>
                <div
                  className={classNames(
                    'i-ph:caret-down text-sm ml-auto transition-transform',
                    deployOpen ? 'rotate-180' : '',
                  )}
                />
              </button>

              {deployOpen && <DeployPanel onClose={close} />}
            </>
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
            <div className="i-ph:globe text-lg" />
            <span>Recherche Web</span>
            <div className="ml-auto">
              <WebSearch onSearchResult={props.onWebSearchResult} disabled={props.webSearchDisabled} />
            </div>
          </div>

          <div className="h-px bg-bolt-elements-borderColor my-1 mx-2" />

          {/* Tous les connecteurs (MCP, Supabase, GitHub, Vercel) regroupés
              sous une seule entrée, comme la section "Connecteurs" de
              l'app Claude, au lieu d'être étalés à plat dans ce menu. */}
          <button
            type="button"
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1"
            onClick={() => setConnectorsOpen((v) => !v)}
          >
            <div className="i-ph:plugs-connected text-lg" />
            <span>Connecteurs</span>
            <div
              className={classNames(
                'i-ph:caret-down text-sm ml-auto transition-transform',
                connectorsOpen ? 'rotate-180' : '',
              )}
            />
          </button>

          {connectorsOpen && (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2.5 pl-8 pr-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
                <div className="i-ph:wrench text-lg" />
                <span>Outils MCP</span>
                <div className="ml-auto">
                  <McpTools />
                </div>
              </div>

              <div className="flex items-center gap-2.5 pl-8 pr-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
                <div className="i-ph:database text-lg" />
                <span>Supabase</span>
                <div className="ml-auto">
                  <SupabaseConnection />
                </div>
              </div>

              <ConnectorRow
                provider="github"
                status={connectedStatus}
                loading={connectedLoading}
                connecting={connectingProvider}
                connect={connectProvider}
                disconnect={disconnectProvider}
                onClose={close}
              />
              <ConnectorRow
                provider="vercel"
                status={connectedStatus}
                loading={connectedLoading}
                connecting={connectingProvider}
                connect={connectProvider}
                disconnect={disconnectProvider}
                onClose={close}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

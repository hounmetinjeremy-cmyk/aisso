/**
 * RemoteContainer
 * ================
 * Remplace `@webcontainer/api` par un client qui parle, via WebSocket, à un
 * agent Node.js exécuté DANS un vrai conteneur Docker sur Cloudflare
 * (voir /container/agent). Le terminal et les builds tournent donc côté
 * serveur, plus dans le navigateur mobile.
 *
 * Ce fichier n'expose QUE le sous-ensemble de l'API WebContainer réellement
 * utilisé ailleurs dans le repo (vérifié par grep sur `webcontainer.` dans
 * app/lib/stores/files.ts, app/lib/stores/previews.ts,
 * app/lib/runtime/action-runner.ts, app/lib/hooks/useGit.ts, app/utils/shell.ts) :
 *
 *  - workdir
 *  - fs.readdir / readFile / writeFile / mkdir / rm
 *  - internal.watchPaths(options, callback)
 *  - spawn(command, args, options) -> { output, input, exit, kill }
 *  - on('server-ready' | 'port', handler)
 *  - setPreviewScript() (no-op pour l'instant, voir TODO en bas de fichier)
 *
 * Limitations connues (à améliorer dans un prochain passage, PAS bloquantes
 * pour npm install / npm run build / git / édition de fichiers) :
 *  - Pas de vrai PTY côté conteneur (pas de node-pty) : les commandes
 *    interactives complexes (ex: prompts avec flèches, TUI) ne seront pas
 *    parfaitement fidèles à un vrai terminal. stdin/stdout/stderr en revanche
 *    fonctionnent normalement en streaming.
 *  - `setPreviewScript` (injection d'un script de capture d'erreurs dans
 *    l'iframe de preview) n'est pas encore relayé au conteneur distant.
 */

export interface PathWatcherEvent {
  type: 'add_dir' | 'remove_dir' | 'add_file' | 'remove_file' | 'change' | 'update_directory';
  path: string;
  buffer?: Uint8Array;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  terminal?: { cols?: number; rows?: number };
}

interface RemoteProcess {
  output: ReadableStream<string>;
  input: WritableStream<string>;
  exit: Promise<number>;
  kill: () => void;
  resize?: (dims: { cols: number; rows: number }) => void;
}

type ServerReadyHandler = (port: number, url: string) => void;
type PortHandler = (port: number, type: 'open' | 'close', url: string) => void;

type WireResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { event: 'watch'; events: PathWatcherEvent[] }
  | { event: 'proc.data'; procId: number; data: string }
  | { event: 'proc.exit'; procId: number; code: number }
  | { event: 'port'; port: number; status: 'open' | 'close'; url: string }
  | { event: 'search.match'; id: number; path: string; matches: unknown[] };

/** Construit l'URL du canal de contrôle WebSocket pour une session donnée. */
function buildAgentWsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/container/${encodeURIComponent(sessionId)}/agent-ws`;
}

/** Construit l'URL de preview (proxifiée par le Worker) pour un port donné. */
function buildPreviewUrl(sessionId: string, port: number): string {
  return `${location.origin}/api/container/${encodeURIComponent(sessionId)}/preview/${port}/`;
}

export class RemoteContainer {
  readonly workdir: string;

  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private watchCallback: ((events: PathWatcherEvent[]) => void) | null = null;
  private procControllers = new Map<
    number,
    { push: (chunk: string) => void; close: (code: number) => void }
  >();
  private serverReadyHandlers: ServerReadyHandler[] = [];
  private portHandlers: PortHandler[] = [];
  private seenServerReady = false;
  private readyPromise: Promise<void>;

  readonly fs = {
    readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
      const entries = await this.call<any[]>('fs.readdir', { path, options });

      if (!options?.withFileTypes) {
        return entries;
      }

      // L'agent envoie des booléens (JSON ne transporte pas de fonctions) :
      // on reconstitue ici l'interface Dirent-like (`.isDirectory()`,
      // `.isFile()`) attendue par les appelants (ex: useGit.ts).
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory,
        isFile: () => entry.isFile,
      }));
    },
    readFile: async (path: string, encoding?: string) => {
      const result = await this.call<string | number[]>('fs.readFile', { path, encoding });

      // Sans encoding, WebContainer renvoie un Uint8Array : l'agent envoie un
      // tableau de nombres (JSON ne transporte pas de Uint8Array), à reconvertir.
      return encoding ? (result as string) : new Uint8Array(result as number[]);
    },
    writeFile: (path: string, data: string | Uint8Array, encoding?: string) =>
      this.call<void>('fs.writeFile', {
        path,
        encoding,
        // Les Uint8Array ne se sérialisent pas en JSON : on les encode en base64
        // et l'agent les redécode côté conteneur si `binary: true`.
        data: typeof data === 'string' ? data : uint8ArrayToBase64(data),
        binary: typeof data !== 'string',
      }),
    mkdir: (path: string, options?: { recursive?: boolean }) => this.call<void>('fs.mkdir', { path, options }),
    rm: (path: string, options?: { recursive?: boolean }) => this.call<void>('fs.rm', { path, options }),
  };

  private activeSearches = new Map<number, (filePath: string, matches: unknown[]) => void>();

  readonly internal = {
    /**
     * Utilisé par app/components/workbench/Search.tsx (recherche texte dans
     * tout le projet). Reproduit la forme des résultats attendue par ce
     * composant (voir performTextSearch dans Search.tsx) : un `apiMatch` par
     * occurrence, avec `preview.text` = la ligne concernée et
     * `preview.matches[0].startLineNumber` = son numéro de ligne, pour que
     * le calcul `lineIndexInPreview` de Search.tsx retombe toujours sur 0.
     */
    textSearch: async (
      query: string,
      options: Record<string, unknown>,
      onProgress: (filePath: string, apiMatches: unknown[]) => void,
    ) => {
      const id = this.nextId++;
      this.activeSearches.set(id, onProgress);

      try {
        await new Promise<void>((resolve, reject) => {
          this.pending.set(id, { resolve: () => resolve(), reject });
          this.send({ id, op: 'search.text', query, options });
        });
      } finally {
        this.activeSearches.delete(id);
      }
    },

    watchPaths: (
      options: { include: string[]; exclude?: string[]; includeContent?: boolean },
      callback: (events: PathWatcherEvent[]) => void,
    ) => {
      this.watchCallback = callback;

      // Les patterns arrivent en absolu (ex: `${WORK_DIR}/**` = `/home/project/**`).
      // L'agent, lui, ne connaît que des chemins RELATIFS à son propre
      // workspace disque : on retire le préfixe `this.workdir` ici.
      const toRelativePattern = (pattern: string) =>
        pattern.startsWith(this.workdir) ? pattern.slice(this.workdir.length).replace(/^\/+/, '') : pattern;

      this.call('watch.start', {
        options: {
          ...options,
          include: options.include.map(toRelativePattern),
          exclude: options.exclude?.map(toRelativePattern),
        },
      }).catch((error) => {
        console.error('[RemoteContainer] échec du démarrage du watcher :', error);
      });
    },
  };

  private constructor(
    private readonly sessionId: string,
    workdir: string,
  ) {
    this.workdir = workdir;
    this.readyPromise = this.connect();
  }

  static async boot(options: { workdirName: string; sessionId: string }): Promise<RemoteContainer> {
    // WebContainer.boot({ workdirName }) exposait `/home/${workdirName}` comme
    // `webcontainer.workdir` : on garde exactement la même convention car
    // app/utils/constants.ts (WORK_DIR) et plusieurs stores en dépendent pour
    // calculer des chemins relatifs. Le vrai chemin disque côté conteneur
    // (WORKDIR dans container/agent/server.mjs) peut être différent : seuls
    // des chemins RELATIFS transitent sur le fil, donc aucun conflit.
    const workdir = `/home/${options.workdirName}`;
    const container = new RemoteContainer(options.sessionId, workdir);
    await container.readyPromise;

    return container;
  }

  /** No-op pour l'instant : voir TODO en tête de fichier. */
  async setPreviewScript(_script: string): Promise<void> {
    // TODO(phase 2.1) : relayer ce script à l'agent pour qu'il l'injecte dans
    // les réponses HTML du proxy de preview (cf container/README.md).
  }

  on(event: 'server-ready', handler: ServerReadyHandler): void;
  on(event: 'port', handler: PortHandler): void;
  on(event: 'preview-message', handler: (message: unknown) => void): void;
  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'server-ready') {
      this.serverReadyHandlers.push(handler as ServerReadyHandler);
    } else if (event === 'port') {
      this.portHandlers.push(handler as PortHandler);
    }

    // 'preview-message' (erreurs remontées depuis l'iframe de preview) : pas
    // encore relayé par le conteneur distant, voir TODO en tête de fichier.
  }

  async spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<RemoteProcess> {
    // `/bin/jsh` est le shell interne à WebContainer, il n'existe pas dans un
    // vrai conteneur Linux : on le traduit en bash, et l'agent émet lui-même
    // le marqueur OSC "interactive" attendu par app/utils/shell.ts juste
    // après le démarrage du process (voir container/agent/server.mjs).
    const isInteractiveShell = command === '/bin/jsh';
    const actualCommand = isInteractiveShell ? 'bash' : command;
    const actualArgs = isInteractiveShell ? [] : args;

    const { procId } = await this.call<{ procId: number }>('spawn', {
      command: actualCommand,
      args: actualArgs,
      options,
      emitInteractiveMarker: isInteractiveShell,
    });

    let pushChunk: (chunk: string) => void = () => {};
    let closeStream: (code: number) => void = () => {};
    let exitResolve: (code: number) => void = () => {};

    const exit = new Promise<number>((resolve) => {
      exitResolve = resolve;
    });

    const output = new ReadableStream<string>({
      start: (controller) => {
        pushChunk = (chunk) => controller.enqueue(chunk);
        closeStream = (code) => {
          controller.close();
          exitResolve(code);
        };
      },
    });

    this.procControllers.set(procId, { push: pushChunk, close: closeStream });

    const input = new WritableStream<string>({
      write: (chunk) => {
        this.send({ op: 'proc.stdin', procId, data: chunk });
      },
    });

    return {
      output,
      input,
      exit,
      kill: () => this.send({ op: 'proc.kill', procId }),
      resize: (dims) => this.send({ op: 'proc.resize', procId, ...dims }),
    };
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(buildAgentWsUrl(this.sessionId));

      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('Connexion au conteneur distant impossible')));
      this.ws.addEventListener('close', () => {
        console.warn('[RemoteContainer] connexion WebSocket fermée, tentative de reconnexion...');
        setTimeout(() => this.connect().catch(() => {}), 2000);
      });
      this.ws.addEventListener('message', (event) => this.handleMessage(event));
    });
  }

  private handleMessage(event: MessageEvent) {
    let message: WireResponse;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    // Important : `search.match` a AUSSI un `id` (celui de l'appel textSearch
    // en cours) donc on discrimine d'abord sur la présence de `event`, pas de
    // `id`, pour ne pas le faire atterrir par erreur dans la logique
    // request/response ci-dessous.
    if (!('event' in message)) {
      const pending = this.pending.get(message.id);

      if (!pending) {
        return;
      }

      this.pending.delete(message.id);

      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }

      return;
    }

    switch (message.event) {
      case 'search.match': {
        const anyMessage = message as unknown as { id: number; path: string; matches: unknown[] };
        this.activeSearches.get(anyMessage.id)?.(anyMessage.path, anyMessage.matches);
        break;
      }

      case 'watch': {
        // L'agent envoie `buffer` en tableau de nombres (JSON ne transporte
        // pas de Uint8Array) ; files.ts#isBinaryFile/#decodeFileContent
        // attendent un vrai Uint8Array (ils lisent .buffer/.byteOffset), on
        // reconvertit donc ici avant de transmettre au callback.
        const events = message.events.map((e) => ({
          ...e,
          buffer: Array.isArray(e.buffer) ? new Uint8Array(e.buffer as unknown as number[]) : e.buffer,
        }));
        this.watchCallback?.(events);
        break;
      }

      case 'proc.data': {
        this.procControllers.get(message.procId)?.push(message.data);
        break;
      }

      case 'proc.exit': {
        this.procControllers.get(message.procId)?.close(message.code);
        this.procControllers.delete(message.procId);
        break;
      }

      case 'port': {
        const url = buildPreviewUrl(this.sessionId, message.port);

        if (message.status === 'open' && !this.seenServerReady) {
          this.seenServerReady = true;

          for (const handler of this.serverReadyHandlers) {
            handler(message.port, url);
          }
        }

        for (const handler of this.portHandlers) {
          handler(message.port, message.status, url);
        }

        break;
      }
    }
  }

  private send(payload: Record<string, unknown>) {
    this.ws.send(JSON.stringify(payload));
  }

  private call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, op, ...payload });
    });
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

/**
 * Identifiant de session persistant côté navigateur : associe cet appareil
 * à "son" conteneur (une Durable Object par sessionId côté Worker).
 * TODO(phase 2.2) : envisager de le lier au chat courant plutôt qu'à
 * l'appareil, pour que deux chats distincts aient des conteneurs distincts.
 */
export function getOrCreateContainerSessionId(): string {
  const STORAGE_KEY = 'bolt_container_session_id';
  let sessionId = localStorage.getItem(STORAGE_KEY);

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, sessionId);
  }

  return sessionId;
}

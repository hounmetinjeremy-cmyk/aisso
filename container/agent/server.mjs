/**
 * Agent du conteneur distant.
 * ============================
 * Tourne DANS le conteneur Docker (voir ../Dockerfile), écoute sur
 * AGENT_PORT (8081) et expose, via une unique connexion WebSocket, les
 * opérations que app/lib/webcontainer/remote-container-client.ts consomme :
 * fichiers, exécution de commandes, watcher, et détection des ports ouverts
 * (pour la preview).
 *
 * Pas de dépendance native (pas de node-pty) pour que le build Docker reste
 * simple et rapide : les commandes sont lancées avec child_process.spawn
 * (stdout/stderr en pipe, pas un vrai PTY). Suffisant pour npm install,
 * npm run build, les commandes git, et un shell bash basique.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile as fsWriteFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { minimatch } from 'minimatch';

const AGENT_PORT = process.env.AGENT_PORT ? Number(process.env.AGENT_PORT) : 8081;
const WORKDIR = process.env.WORKDIR || '/workspace/project';

await mkdir(WORKDIR, { recursive: true });

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('agent ok');
});

const wss = new WebSocketServer({ server: httpServer, path: '/agent-ws' });

wss.on('connection', (ws) => {
  const procs = new Map();
  let watcher = null;
  let procCounter = 1;

  const send = (payload) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const ok = (id, result) => send({ id, ok: true, result });
  const fail = (id, error) => send({ id, ok: false, error: error?.message || String(error) });

  const resolvePath = (relativePath) => {
    const resolved = path.resolve(WORKDIR, relativePath || '.');

    // Garde-fou : on n'autorise pas de sortir du workspace du conteneur.
    if (!resolved.startsWith(WORKDIR)) {
      throw new Error(`Chemin en dehors du workspace refusé : ${relativePath}`);
    }

    return resolved;
  };

  ws.on('message', async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { id, op } = message;

    try {
      switch (op) {
        case 'fs.readdir': {
          const entries = await readdir(resolvePath(message.path), {
            withFileTypes: Boolean(message.options?.withFileTypes),
          });
          // Important : on envoie des booléens, pas des fonctions (les
          // fonctions ne survivent pas à JSON.stringify). Le client
          // reconstruit `.isDirectory()`/`.isFile()` à la réception.
          ok(
            id,
            message.options?.withFileTypes
              ? entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }))
              : entries.map((e) => (typeof e === 'string' ? e : e.name)),
          );
          break;
        }

        case 'fs.readFile': {
          const content = await readFile(resolvePath(message.path), message.encoding || undefined);
          ok(id, message.encoding ? content.toString(message.encoding) : Array.from(content));
          break;
        }

        case 'fs.writeFile': {
          const target = resolvePath(message.path);
          await mkdir(path.dirname(target), { recursive: true });

          const data = message.binary ? Buffer.from(message.data, 'base64') : message.data;
          await fsWriteFile(target, data, message.encoding || undefined);
          ok(id, undefined);
          break;
        }

        case 'fs.mkdir': {
          await mkdir(resolvePath(message.path), { recursive: message.options?.recursive ?? true });
          ok(id, undefined);
          break;
        }

        case 'fs.rm': {
          await rm(resolvePath(message.path), { recursive: Boolean(message.options?.recursive), force: true });
          ok(id, undefined);
          break;
        }

        case 'watch.start': {
          watcher?.close();

          // `include`/`exclude` arrivent déjà relatifs au workspace (traduction
          // faite côté client dans remote-container-client.ts).
          const { include, exclude = [], includeContent } = message.options;
          watcher = chokidar.watch(
            include.map((p) => path.join(WORKDIR, p)),
            {
              ignoreInitial: true,
              ignored: (filePath) => {
                const rel = path.relative(WORKDIR, filePath);
                return exclude.some((pattern) => minimatch(rel, pattern) || minimatch('/' + rel, pattern));
              },
            },
          );

          const emit = async (type, filePath) => {
            const relativePath = '/' + path.relative(WORKDIR, filePath);

            let buffer;

            if (includeContent && (type === 'add_file' || type === 'change')) {
              try {
                buffer = Array.from(await readFile(filePath));
              } catch {
                buffer = undefined;
              }
            }

            send({ event: 'watch', events: [{ type, path: relativePath, buffer }] });
          };

          watcher.on('addDir', (p) => emit('add_dir', p));
          watcher.on('unlinkDir', (p) => emit('remove_dir', p));
          watcher.on('add', (p) => emit('add_file', p));
          watcher.on('unlink', (p) => emit('remove_file', p));
          watcher.on('change', (p) => emit('change', p));

          ok(id, undefined);
          break;
        }

        case 'spawn': {
          const procId = procCounter++;
          const child = spawn(message.command, message.args || [], {
            cwd: message.options?.cwd ? resolvePath(message.options.cwd) : WORKDIR,
            env: { ...process.env, ...message.options?.env, TERM: 'xterm-256color' },
            shell: false,
          });

          procs.set(procId, child);

          child.stdout.on('data', (chunk) => send({ event: 'proc.data', procId, data: chunk.toString('utf-8') }));
          child.stderr.on('data', (chunk) => send({ event: 'proc.data', procId, data: chunk.toString('utf-8') }));
          child.on('exit', (code) => {
            send({ event: 'proc.exit', procId, code: code ?? 0 });
            procs.delete(procId);
          });
          child.on('error', (error) => {
            send({ event: 'proc.data', procId, data: `\r\n[agent] ${error.message}\r\n` });
            send({ event: 'proc.exit', procId, code: 1 });
            procs.delete(procId);
          });

          // Simule le marqueur OSC "interactive" que jsh (WebContainer) émet
          // normalement, attendu par app/utils/shell.ts avant d'envoyer du stdin.
          if (message.emitInteractiveMarker) {
            send({ event: 'proc.data', procId, data: '\x1b]654;interactive\x07' });
          }

          ok(id, { procId });
          break;
        }

        case 'search.text': {
          await runTextSearch(WORKDIR, message.query, message.options || {}, (filePath, matches) => {
            send({ event: 'search.match', id, path: filePath, matches });
          });
          ok(id, undefined);
          break;
        }

        case 'proc.stdin': {
          procs.get(message.procId)?.stdin?.write(message.data);
          break;
        }

        case 'proc.kill': {
          procs.get(message.procId)?.kill();
          break;
        }

        default:
          fail(id, new Error(`Opération inconnue : ${op}`));
      }
    } catch (error) {
      fail(id, error);
    }
  });

  ws.on('close', () => {
    watcher?.close();

    for (const child of procs.values()) {
      child.kill();
    }
  });
});

startPortWatcher((port, status) => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ event: 'port', port, status, url: '' }));
    }
  }
});

httpServer.listen(AGENT_PORT, () => {
  console.log(`[agent] à l'écoute sur le port ${AGENT_PORT}, workspace=${WORKDIR}`);
});

/**
 * Détecte les ports TCP ouverts par les process enfants (ex: le serveur de
 * dev Vite lancé via `npm run dev`) en lisant périodiquement /proc/net/tcp.
 * Volontairement sans dépendance : /proc/net/tcp est disponible sur toute
 * image Linux standard.
 */
function startPortWatcher(onChange) {
  const IGNORED_PORTS = new Set([AGENT_PORT]);
  let previouslyOpen = new Set();

  setInterval(async () => {
    let openPorts;

    try {
      openPorts = await readListeningPorts();
    } catch {
      return;
    }

    const current = new Set([...openPorts].filter((p) => !IGNORED_PORTS.has(p)));

    for (const port of current) {
      if (!previouslyOpen.has(port)) {
        onChange(port, 'open');
      }
    }

    for (const port of previouslyOpen) {
      if (!current.has(port)) {
        onChange(port, 'close');
      }
    }

    previouslyOpen = current;
  }, 1000);
}

const SEARCH_IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.next', '.astro']);

/**
 * Recherche texte récursive sur le workspace (remplace
 * `webcontainer.internal.textSearch`, utilisée par Search.tsx).
 * Émet un batch de résultats par fichier via `onFileMatches`.
 */
async function runTextSearch(root, query, options, onFileMatches) {
  if (!query) {
    return;
  }

  const flags = options.caseSensitive ? 'g' : 'gi';
  const pattern = options.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(options.matchWholeWord ? `\\b${pattern}\\b` : pattern, flags);

  async function walk(dir) {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SEARCH_IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      let content;

      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        continue; // fichier binaire ou illisible : on ignore silencieusement
      }

      const relativePath = '/' + path.relative(root, fullPath);
      const lines = content.split('\n');
      const matches = [];

      lines.forEach((lineText, index) => {
        regex.lastIndex = 0;

        let match;

        while ((match = regex.exec(lineText))) {
          matches.push({
            preview: { text: lineText, matches: [{ startLineNumber: index + 1 }] },
            ranges: [{ startLineNumber: index + 1, startColumn: match.index + 1, endColumn: match.index + 1 + match[0].length }],
          });

          if (match[0].length === 0) {
            regex.lastIndex++;
          }
        }
      });

      if (matches.length > 0) {
        onFileMatches(relativePath, matches);
      }
    }
  }

  await walk(root);
}

async function readListeningPorts() {
  const content = await readFile('/proc/net/tcp', 'utf-8');
  const ports = new Set();

  for (const line of content.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);

    if (columns.length < 4) {
      continue;
    }

    const [, localAddress, , state] = columns;

    // 0A = LISTEN en hexadécimal (cf. include/net/tcp_states.h du noyau Linux)
    if (state !== '0A') {
      continue;
    }

    const portHex = localAddress.split(':')[1];
    ports.add(parseInt(portHex, 16));
  }

  return ports;
}

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Terminal réel pour Aïsso, hébergé séparément (Render.com — voir README.md
 * de ce dossier) car un Worker Cloudflare ne peut exécuter aucune commande
 * shell lui-même. Aïsso appelle POST /run en HTTPS normal depuis son code
 * serveur ; ce service exécute la commande pour de vrai et renvoie le
 * résultat réel (stdout/stderr/code de sortie).
 *
 * SÉCURITÉ : cette route exécute n'importe quelle commande shell reçue —
 * c'est littéralement une porte d'exécution de code à distance par design.
 * EXEC_SERVICE_TOKEN est la SEULE protection : à générer aléatoirement
 * (ex: `openssl rand -hex 32`), à ne JAMAIS committer, et à renseigner de
 * façon identique ici (variable d'environnement Render) et côté Aïsso
 * (secret Cloudflare). Le service refuse de démarrer sans ce jeton pour ne
 * jamais tourner accidentellement sans protection.
 */

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.EXEC_SERVICE_TOKEN;

if (!TOKEN) {
  console.error('EXEC_SERVICE_TOKEN manquant — refus de démarrer sans protection. Voir README.md.');
  process.exit(1);
}

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || '/workspace');
fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 200_000;

const app = express();
app.use(express.json({ limit: '1mb' }));

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }

  return { text: text.slice(-MAX_OUTPUT_CHARS), truncated: true };
}

/** Empêche un `cwd` de sortir de WORKSPACE_ROOT (ex: "../../etc") — le conteneur est jetable, mais autant éviter les erreurs bêtes. */
function resolveWorkspacePath(relativeCwd) {
  const resolved = path.resolve(WORKSPACE_ROOT, relativeCwd || '.');

  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    return null;
  }

  return resolved;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/run', (req, res) => {
  const auth = req.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  if (provided !== TOKEN) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }

  const { command, cwd, timeoutMs } = req.body || {};

  if (typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ error: 'command manquant ou vide.' });
  }

  // Trace verifiable dans les logs Render (type "app") — sert a distinguer un vrai appel d'une reponse inventee cote IA.
  console.log(`[run] ${new Date().toISOString()} cwd=${cwd || '.'} command=${JSON.stringify(command)}`);

  const resolvedCwd = resolveWorkspacePath(typeof cwd === 'string' ? cwd : undefined);

  if (!resolvedCwd) {
    return res.status(400).json({ error: 'cwd invalide (doit rester dans le workspace).' });
  }

  fs.mkdirSync(resolvedCwd, { recursive: true });

  const effectiveTimeout = Math.min(
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const startedAt = Date.now();

  exec(
    command,
    { cwd: resolvedCwd, timeout: effectiveTimeout, maxBuffer: 20 * 1024 * 1024, shell: '/bin/bash' },
    (error, stdout, stderr) => {
      const durationMs = Date.now() - startedAt;
      const outTruncated = truncate(stdout ?? '');
      const errTruncated = truncate(stderr ?? '');
      const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;

      console.log(`[run] ${new Date().toISOString()} exitCode=${exitCode} durationMs=${durationMs}`);

      res.json({
        stdout: outTruncated.text,
        stderr: errTruncated.text,
        outputTruncated: outTruncated.truncated || errTruncated.truncated,
        exitCode,
        timedOut: error?.killed === true && error?.signal === 'SIGTERM',
        durationMs,
      });
    },
  );
});

// Dossiers jamais utiles à remonter vers l'éditeur — lourds et/ou régénérables.
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'out',
  'target',
  'vendor',
  '.venv',
  '__pycache__',
  '.wrangler',
]);

const MAX_TREE_FILES = 800;
const MAX_FILE_CONTENT_BYTES = 300_000;
const MAX_TOTAL_TREE_BYTES = 8_000_000;

/** Heuristique simple : un fichier avec un octet nul dans ses premiers Ko est traité comme binaire. */
function looksBinary(buffer) {
  const sampleLength = Math.min(buffer.length, 8000);

  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  return false;
}

function walkDirectory(rootDir) {
  const files = [];
  let totalBytes = 0;
  let truncated = false;

  function visit(currentDir) {
    if (truncated) {
      return;
    }

    let entries;

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) {
        return;
      }

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          continue;
        }

        visit(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (files.length >= MAX_TREE_FILES || totalBytes >= MAX_TOTAL_TREE_BYTES) {
        truncated = true;
        return;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');

      let stat;

      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }

      if (stat.size > MAX_FILE_CONTENT_BYTES) {
        files.push({ path: relativePath, content: '', isBinary: true, skippedReason: 'too_large' });
        continue;
      }

      let buffer;

      try {
        buffer = fs.readFileSync(absolutePath);
      } catch {
        continue;
      }

      if (looksBinary(buffer)) {
        files.push({ path: relativePath, content: '', isBinary: true, skippedReason: 'binary' });
        continue;
      }

      totalBytes += buffer.length;
      files.push({ path: relativePath, content: buffer.toString('utf8'), isBinary: false });
    }
  }

  visit(rootDir);

  return { files, truncated };
}

app.post('/tree', (req, res) => {
  const auth = req.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  if (provided !== TOKEN) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }

  const { dir } = req.body || {};
  const resolvedDir = resolveWorkspacePath(typeof dir === 'string' ? dir : undefined);

  if (!resolvedDir) {
    return res.status(400).json({ error: 'dir invalide (doit rester dans le workspace).' });
  }

  if (!fs.existsSync(resolvedDir)) {
    return res.status(404).json({ error: `Dossier introuvable : ${dir || '.'}` });
  }

  console.log(`[tree] ${new Date().toISOString()} dir=${dir || '.'}`);

  const { files, truncated } = walkDirectory(resolvedDir);

  console.log(`[tree] ${new Date().toISOString()} files=${files.length} truncated=${truncated}`);

  res.json({ files, truncated });
});

app.listen(PORT, () => {
  console.log(`aisso-exec-service à l'écoute sur le port ${PORT}, workspace: ${WORKSPACE_ROOT}`);
});

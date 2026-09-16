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

app.listen(PORT, () => {
  console.log(`aisso-exec-service à l'écoute sur le port ${PORT}, workspace: ${WORKSPACE_ROOT}`);
});

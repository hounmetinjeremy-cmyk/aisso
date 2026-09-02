/**
 * Import automatique et déterministe d'un dépôt GitHub mentionné en langage
 * naturel dans le chat — contourne délibérément le function calling du SDK
 * IA (voir github-tools.ts) : les modèles Gemini "thinking" échouent sur les
 * appels d'outils enchaînés faute de support de `thought_signature` dans la
 * version installée du SDK (limite connue, pas un bug de cette logique).
 *
 * Ici, aucun appel d'outil n'est fait par le modèle : le Worker détecte
 * lui-même l'intention dans le dernier message, importe les fichiers, les
 * injecte directement dans le contexte de CETTE génération (le modèle peut
 * donc en parler immédiatement), et prévient le client via le data stream
 * pour qu'il les écrive dans FilesStore — ça marche avec n'importe quel
 * modèle, y compris ceux touchés par la limite ci-dessus.
 */

import type { DataStreamWriter } from 'ai';
import { WORK_DIR } from '~/utils/constants';
import type { FileMap } from './constants';
import { getGithubToken } from './github-tools';
import { importRepoFiles, listUserRepos, type RepoSummary } from '~/lib/github-import.server';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('github-auto-import');

const TRIGGER_RE =
  /\b(va(?:s)? chercher|importe(?:r)?|récupère(?:r)?|recupere(?:r)?|charge(?:r)?|ouvre(?:r)?|reprend(?:re)?|clone(?:r)?|fetch|import|open|load)\b/i;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function matchRepoByName(repos: RepoSummary[], text: string): RepoSummary | null {
  const normalizedText = normalize(text);
  const matches = repos.filter((repo) => {
    const name = normalize(repo.name);
    const spaced = name.replace(/[-_]/g, ' ');
    return name.length >= 3 && (normalizedText.includes(name) || normalizedText.includes(spaced));
  });

  // Ambigu (0 ou plusieurs dépôts correspondent au nom mentionné) : on
  // n'importe rien plutôt que de deviner, le modèle répondra normalement.
  return matches.length === 1 ? matches[0] : null;
}

export interface AutoImportResult {
  owner: string;
  repo: string;
  branch: string;
  fileCount: number;
}

/**
 * Si le dernier message utilisateur ressemble à une demande d'import d'un
 * dépôt connecté (verbe d'action + nom de dépôt reconnu), importe ses
 * fichiers et les fusionne dans `files` (mutation directe, même forme que
 * le FileMap déjà utilisé pour le contexte du projet). Ne fait rien
 * silencieusement dans tous les autres cas (pas de dépôt connecté, aucun nom
 * reconnu, ambiguïté) — jamais bloquant pour la réponse du chat.
 */
export async function autoImportGithubRepo(params: {
  env: Env;
  userId: string | null;
  lastUserMessageText: string;
  files: FileMap;
  dataStream: DataStreamWriter;
}): Promise<AutoImportResult | null> {
  const { env, userId, lastUserMessageText, files, dataStream } = params;

  if (!userId || !lastUserMessageText || !TRIGGER_RE.test(lastUserMessageText)) {
    return null;
  }

  try {
    const token = await getGithubToken(env, userId);

    if (!token) {
      return null;
    }

    const repos = await listUserRepos(token);
    const match = matchRepoByName(repos, lastUserMessageText);

    if (!match) {
      return null;
    }

    const result = await importRepoFiles(token, { owner: match.owner, repo: match.name, branch: match.defaultBranch });

    if (result.files.length === 0) {
      return null;
    }

    for (const file of result.files) {
      files[`${WORK_DIR}/${file.path}`] = { type: 'file', content: file.content, isBinary: false };
    }

    dataStream.writeData({
      type: 'githubAutoImport',
      owner: match.owner,
      repo: match.name,
      branch: match.defaultBranch,
      files: result.files.map((file) => ({ path: file.path, content: file.content })),
      skipped: result.skipped,
    });

    return { owner: match.owner, repo: match.name, branch: match.defaultBranch, fileCount: result.files.length };
  } catch (error) {
    logger.error('autoImportGithubRepo failed', error);
    return null;
  }
}

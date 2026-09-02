/**
 * Import automatique et déterministe d'un dépôt GitHub mentionné en langage
 * naturel dans le chat. Implémentation de référence du pattern "IA cerveau /
 * Worker exécutant" décrit dans `ai-intent-classifier.ts` — lire ce fichier
 * en premier pour le contexte général (pourquoi jamais de tool-calling).
 *
 * Ici, aucun appel d'outil n'est fait par le modèle : le Worker détecte
 * lui-même l'intention, importe les fichiers, les injecte directement dans
 * le contexte de CETTE génération (le modèle peut donc en parler
 * immédiatement), et prévient le client via le data stream pour qu'il les
 * écrive dans FilesStore — ça marche avec n'importe quel modèle.
 *
 * Le verbe déclencheur ("importe", "va chercher"...) et le nom du dépôt ne
 * sont pas forcément dans le même message (l'utilisateur écrit souvent en
 * plusieurs messages : "je veux modifier mon projet betesim" puis "il faut
 * l'importer") — voir `resolveImportTarget` qui regarde une petite fenêtre
 * des derniers messages utilisateur pour recoller les deux.
 *
 * Quand ça ne suffit pas (nom de dépôt paraphrasé, faute de frappe, formulé
 * autrement que par une correspondance exacte de sous-chaîne), `classifyIntentWithAI`
 * (`ai-intent-classifier.ts`) prend le relais. Ce recours ne se déclenche que
 * si un verbe d'import a été détecté récemment (pas sur chaque message), pour
 * ne pas ajouter un appel IA à chaque tour de chat.
 */

import type { DataStreamWriter } from 'ai';
import { WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import type { FileMap } from './constants';
import { getGithubToken } from './github-tools';
import { importRepoFiles, listUserRepos, type RepoSummary } from '~/lib/github-import.server';
import { classifyIntentWithAI } from './ai-intent-classifier';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('github-auto-import');

const TRIGGER_RE =
  /\b(va(?:s)? chercher|importe(?:r)?|récupère(?:r)?|recupere(?:r)?|charge(?:r)?|ouvre(?:r)?|reprend(?:re)?|clone(?:r)?|fetch|import|open|load)\b/i;

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchRepoByName(repos: RepoSummary[], text: string): RepoSummary | null {
  const normalizedText = normalize(text);
  const matches = repos.filter((repo) => {
    const name = normalize(repo.name);
    const spaced = name.replace(/[-_]/g, ' ');

    return name.length >= 3 && (normalizedText.includes(name) || normalizedText.includes(spaced));
  });

  /*
   * Ambigu (0 ou plusieurs dépôts correspondent au nom mentionné) : on
   * n'importe rien plutôt que de deviner, le modèle répondra normalement.
   */
  return matches.length === 1 ? matches[0] : null;
}

export interface AutoImportResult {
  owner: string;
  repo: string;
  branch: string;
  fileCount: number;
}

/*
 * Combien de derniers messages utilisateur on regarde pour recoller un
 * verbe d'import et un nom de dépôt mentionnés séparément.
 */
const LOOKBACK_MESSAGES = 6;

/**
 * Détermine, à partir des derniers messages utilisateur (le plus récent en
 * premier), quel dépôt importer — sans exiger que le verbe d'action et le
 * nom du dépôt soient dans le même message. Trois cas couverts :
 *
 *  A. Verbe ET nom dans le dernier message ("va chercher betesim").
 *  B. Nom mentionné plus tôt, verbe seul dans le dernier message
 *     ("je veux modifier betesim" ... puis "il faut l'importer").
 *  C. Verbe mentionné plus tôt, nom seul dans le dernier message
 *     ("importe mon projet" ... puis juste "betesim" en réponse).
 *
 * Renvoie `null` si rien de net ne se dégage (pas de verbe récent, ou nom
 * ambigu/introuvable) — le modèle répond alors normalement.
 */
function resolveImportTarget(repos: RepoSummary[], recentUserMessages: string[]): RepoSummary | null {
  const [lastMessage] = recentUserMessages;

  if (!lastMessage) {
    return null;
  }

  const triggerInLast = TRIGGER_RE.test(lastMessage);
  const matchInLast = matchRepoByName(repos, lastMessage);

  // Cas A : tout est dans le dernier message.
  if (triggerInLast && matchInLast) {
    return matchInLast;
  }

  const previousMessages = recentUserMessages.slice(1, LOOKBACK_MESSAGES);

  // Cas C : verbe maintenant, nom mentionné juste avant.
  if (triggerInLast && !matchInLast) {
    for (const text of previousMessages) {
      const match = matchRepoByName(repos, text);

      if (match) {
        return match;
      }
    }

    return null;
  }

  // Cas B : nom maintenant, verbe mentionné juste avant.
  if (!triggerInLast && matchInLast) {
    const hadTriggerRecently = previousMessages.some((text) => TRIGGER_RE.test(text));
    return hadTriggerRecently ? matchInLast : null;
  }

  return null;
}

const IMPORT_CLASSIFIER_INSTRUCTIONS =
  "Tu analyses les derniers messages d'un utilisateur pour détecter s'il veut importer un de ses dépôts GitHub " +
  "existants dans le projet en cours (le récupérer, l'ouvrir, ou reprendre le travail dessus).";

/**
 * Si les derniers messages utilisateur ressemblent à une demande d'import
 * d'un dépôt connecté (verbe d'action + nom de dépôt reconnu, voir
 * `resolveImportTarget`, avec `classifyIntentWithAI` en dernier
 * recours), importe ses fichiers et les fusionne dans `files` (mutation
 * directe, même forme que le FileMap déjà utilisé pour le contexte du
 * projet). Ne fait rien silencieusement dans tous les autres cas (pas de
 * dépôt connecté, aucun nom reconnu, ambiguïté) — jamais bloquant pour la
 * réponse du chat.
 */
export async function autoImportGithubRepo(params: {
  env: Env;
  userId: string | null;
  recentUserMessages: string[];
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  currentModel?: string;
  currentProviderName?: string;
  files: FileMap;
  dataStream: DataStreamWriter;
}): Promise<AutoImportResult | null> {
  const {
    env,
    userId,
    recentUserMessages,
    apiKeys,
    providerSettings,
    currentModel,
    currentProviderName,
    files,
    dataStream,
  } = params;

  if (!userId || recentUserMessages.length === 0) {
    return null;
  }

  try {
    const token = await getGithubToken(env, userId);

    if (!token) {
      return null;
    }

    const repos = await listUserRepos(token);
    let match = resolveImportTarget(repos, recentUserMessages);

    // Recours IA : seulement si un verbe d'import a été vu récemment, pour ne pas payer un appel à chaque message.
    if (!match && recentUserMessages.some((text) => TRIGGER_RE.test(text))) {
      match = await classifyIntentWithAI({
        options: repos,
        recentUserMessages,
        instructions: IMPORT_CLASSIFIER_INSTRUCTIONS,
        env,
        apiKeys,
        providerSettings,
        currentModel,
        currentProviderName,
      });
    }

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

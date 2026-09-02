/**
 * Pattern officiel pour toute action IA "sensible" (GitHub, Supabase,
 * Vercel...) dans Aïsso : le modèle ne pilote JAMAIS directement un service
 * externe via function calling / tool-calling — Gemini "thinking" (modèle
 * par défaut de l'app) plante sur les appels d'outils enchaînés faute de
 * support de `thought_signature` dans le SDK installé (voir
 * `github-tools.ts`). C'est un plantage connu, déjà rencontré et corrigé une
 * fois ; ne pas réintroduire de tool-calling pour contourner ce fichier.
 *
 * Architecture à trois rôles :
 *  1. Le Worker (code déterministe, jamais le modèle) détecte d'abord
 *     l'intention avec des règles simples et rapides (regex, correspondance
 *     de nom...) — c'est gratuit, instantané, et couvre la grande majorité
 *     des cas. Voir par ex. `resolveImportTarget` dans github-auto-import.ts.
 *  2. Quand la détection déterministe échoue (formulation paraphrasée, faute
 *     de frappe, périphrase) MAIS qu'un signal fort d'intention existe déjà
 *     (verbe d'action détecté récemment), `classifyIntentWithAI` ci-dessous
 *     prend le relais : un simple `generateText` TEXTE, SANS AUCUN outil, qui
 *     ne peut choisir qu'une option EXACTE dans une liste fermée fournie par
 *     le Worker (jamais une valeur inventée) — ou répondre qu'aucune option
 *     ne correspond.
 *  3. Le Worker (encore lui, jamais le modèle) exécute ensuite l'action de
 *     façon déterministe et sécurisée avec l'option choisie (ex. import,
 *     commit, migration Supabase...).
 *
 * Ne se déclenche que quand un signal d'intention existe déjà (jamais à
 * chaque message de chat) : chaque appel a un coût et une latence, réservés
 * aux cas où la détection rapide a échoué mais où on sait déjà que
 * l'utilisateur veut probablement faire quelque chose de précis.
 */

import { generateText } from 'ai';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_LIST } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ai-intent-classifier');

// Nombre de caractères conservés par message dans le prompt de classification (reste léger).
const MESSAGE_CHARS = 300;

export interface ClassifierOption {
  // Identifiant exact que le modèle doit répéter tel quel pour désigner cette option (ex. nom de dépôt).
  name: string;
}

export interface ClassifyIntentParams<T extends ClassifierOption> {
  // Options parmi lesquelles le modèle doit choisir (ou aucune) — jamais une valeur hors de cette liste.
  options: T[];

  // Derniers messages utilisateur, le plus récent en premier (même format que `recentUserMessages` ailleurs).
  recentUserMessages: string[];

  /*
   * Description de la tâche de classification, injectée dans le prompt système juste avant la liste des options
   * et les règles de format de réponse. Ex. : "détecte si l'utilisateur veut importer un de ses dépôts GitHub
   * existants dans le projet en cours."
   */
  instructions: string;

  env?: Env;
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  currentModel?: string;
  currentProviderName?: string;
}

/**
 * Choisit une option dans une liste fermée à partir du langage naturel de
 * l'utilisateur, via un appel `generateText` texte simple (aucun outil).
 * Ne devine jamais une valeur hors de `options` — renvoie `null` au moindre
 * doute (réponse mal formée, aucune option évidente, erreur réseau/modèle).
 */
export async function classifyIntentWithAI<T extends ClassifierOption>(
  params: ClassifyIntentParams<T>,
): Promise<T | null> {
  const {
    options,
    recentUserMessages,
    instructions,
    env,
    apiKeys,
    providerSettings,
    currentModel,
    currentProviderName,
  } = params;

  if (options.length === 0) {
    return null;
  }

  try {
    const provider = PROVIDER_LIST.find((p) => p.name === currentProviderName) || DEFAULT_PROVIDER;
    const model = provider.getModelInstance({
      model: currentModel || DEFAULT_MODEL,
      serverEnv: env as any,
      apiKeys,
      providerSettings,
    });

    const optionNames = options.map((option) => option.name).join(', ');
    const conversation = [...recentUserMessages]
      .reverse()
      .map((text, index) => `[message ${index + 1}] ${text.slice(0, MESSAGE_CHARS)}`)
      .join('\n');

    const { text } = await generateText({
      model,
      temperature: 0,
      system:
        `${instructions} Options disponibles : ${optionNames}. ` +
        "Réponds UNIQUEMENT avec le nom EXACT d'une de ces options si elle correspond clairement à la demande de " +
        "l'utilisateur. Sinon réponds exactement NONE. Pas de phrase, pas de ponctuation, juste le nom de l'option " +
        'ou NONE.',
      prompt: conversation,
    });

    const answer = text.trim();

    return options.find((option) => option.name.toLowerCase() === answer.toLowerCase()) ?? null;
  } catch (error) {
    logger.error('classifyIntentWithAI failed', error);
    return null;
  }
}

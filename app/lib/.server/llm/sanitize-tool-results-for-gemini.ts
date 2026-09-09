import type { CoreMessage } from 'ai';

/**
 * L'API Gemini exige que `function_response.response` soit un objet (un proto
 * Struct) — jamais une chaîne, un nombre ou un booléen brut. Plante avec
 * "Invalid value at ... function_response.response ... type.googleapis.com/
 * google.protobuf.Struct" sinon.
 *
 * Un résultat d'outil (`ToolResultPart.result`) est typé `unknown` côté SDK :
 * rien n'empêche un outil MCP de renvoyer une chaîne brute, et l'ancien flux
 * d'approbation manuelle des outils écrivait littéralement la chaîne
 * "Yes, approved." comme résultat (voir TOOL_EXECUTION_APPROVAL dans
 * constants.ts) — une fois cette valeur figée dans l'historique persisté
 * d'une conversation, elle est renvoyée telle quelle à chaque tour suivant et
 * fait planter Gemini indéfiniment, jamais corrigée par processToolInvocations
 * qui ne retraite que le dernier message.
 *
 * N'est appliquée qu'aux messages envoyés à un modèle Google (voir
 * stream-text.ts) — les autres providers acceptent un résultat non-objet sans
 * problème, pas de perte de fidélité pour eux.
 */
export function sanitizeToolResultsForGemini(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      return message;
    }

    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') {
        return part;
      }

      const { result } = part;
      const isStructCompatible = typeof result === 'object' && result !== null && !Array.isArray(result);

      if (isStructCompatible) {
        return part;
      }

      return { ...part, result: { value: result ?? null } };
    });

    return { ...message, content };
  });
}

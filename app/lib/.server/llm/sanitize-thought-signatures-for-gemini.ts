import type { CoreMessage, LanguageModelV1Middleware, LanguageModelV1Prompt } from 'ai';

/**
 * Sentinel officiel Google : permet de rejouer un functionCall sans la vraie
 * thought_signature (perdue à la persistance client / SDK ancien).
 *
 * Ref: https://ai.google.dev/gemini-api/docs/thought-signatures
 *
 * Sans ça, Gemini 2.5 / 3 renvoie 400 :
 * "Function call is missing a thought_signature in functionCall parts."
 */
const SKIP_SENTINEL = 'skip_thought_signature_validator';

function hasThoughtSignature(part: any): boolean {
  const opts = part?.providerOptions ?? part?.providerMetadata;

  if (!opts || typeof opts !== 'object') {
    return false;
  }

  const google =
    opts.google?.thoughtSignature ??
    opts.google?.thought_signature ??
    opts.vertex?.thoughtSignature ??
    opts.googleVertex?.thoughtSignature;

  return typeof google === 'string' && google.length > 0;
}

function injectSignature(part: any): any {
  if (hasThoughtSignature(part)) {
    return part;
  }

  const existingOpts = part.providerOptions ?? part.providerMetadata ?? {};

  return {
    ...part,
    providerOptions: {
      ...existingOpts,
      google: {
        ...(existingOpts.google || {}),
        thoughtSignature: SKIP_SENTINEL,
      },
    },
  };
}

/**
 * Parcourt les messages core (format AI SDK) et injecte le sentinel sur chaque
 * part `tool-call` assistant qui n'a pas déjà une thought_signature.
 *
 * À appeler uniquement avant un appel Google (voir stream-text.ts).
 */
export function sanitizeThoughtSignaturesForGemini(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }

    if (typeof message.content === 'string') {
      return message;
    }

    if (!Array.isArray(message.content)) {
      return message;
    }

    const content = message.content.map((part: any) => {
      if (part?.type === 'tool-call') {
        return injectSignature(part);
      }

      return part;
    });

    return { ...message, content } as CoreMessage;
  });
}

/**
 * Même correctif que `sanitizeThoughtSignaturesForGemini`, mais posé comme
 * middleware `transformParams` (voir stream-text.ts) plutôt qu'appliqué une
 * fois sur les messages initiaux.
 *
 * Pourquoi : `maxSteps` fait boucler `streamText` en interne — le tool-call
 * généré PAR le modèle à l'étape 1 (jamais passé par notre sanitizer, qui ne
 * tourne qu'une fois avant le premier appel) est rejoué tel quel à l'étape 2
 * par le SDK, sans signature (le provider `@ai-sdk/google` de cette version
 * n'en attache jamais). `transformParams` s'exécute avant CHAQUE appel au
 * modèle wrappé — donc à chaque étape de la boucle — sur le prompt déjà
 * converti au format bas niveau du provider (`LanguageModelV1Prompt`), ce
 * qui est le seul point d'interception disponible pour patcher aussi les
 * tool-calls générés en cours de boucle, pas seulement l'historique client.
 */
function injectSignatureV1(part: any): any {
  if (hasThoughtSignature(part)) {
    return part;
  }

  return {
    ...part,
    providerMetadata: {
      ...part.providerMetadata,
      google: {
        ...(part.providerMetadata?.google || {}),
        thoughtSignature: SKIP_SENTINEL,
      },
    },
  };
}

function sanitizePromptForGemini(prompt: LanguageModelV1Prompt): LanguageModelV1Prompt {
  return prompt.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return message;
    }

    const content = (message.content as any[]).map((part) => {
      if (part?.type === 'tool-call') {
        return injectSignatureV1(part);
      }

      return part;
    });

    return { ...message, content } as typeof message;
  });
}

export function createGeminiThoughtSignatureMiddleware(): LanguageModelV1Middleware {
  return {
    transformParams: async ({ params }) => ({
      ...params,
      prompt: sanitizePromptForGemini(params.prompt),
    }),
  };
}

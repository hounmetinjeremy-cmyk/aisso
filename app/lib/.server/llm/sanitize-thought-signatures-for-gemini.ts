import type { CoreMessage } from 'ai';

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

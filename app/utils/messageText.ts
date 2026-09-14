import type { UIMessage } from 'ai';

/**
 * UIMessage v5 n'a plus de `.content` — le texte vit dans les parts
 * `{type: 'text', text}`. Concatène les parts texte d'un message, dans
 * l'ordre, comme l'ancien `.content` le faisait pour un message text-only.
 */
export function getMessageText(message: Pick<UIMessage, 'parts'>): string {
  return (message.parts ?? [])
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

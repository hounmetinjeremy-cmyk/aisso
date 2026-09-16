import { toast } from 'react-toastify';

/*
 * storeMessageHistory/takeSnapshot (voir useChatHistory.ts, Chat.client.tsx)
 * tournent sur un échantillonneur à 50ms pendant toute une réponse en
 * streaming — une coupure réseau de quelques secondes (mobile) y déclenchait
 * autrement des dizaines de toasts d'erreur identiques empilés à l'écran,
 * masquant la conversation. Un seul toast par message distinct et par
 * fenêtre de temps suffit à informer l'utilisateur sans l'inonder.
 */

const lastShownAt = new Map<string, number>();
const DEFAULT_WINDOW_MS = 8000;

export function toastErrorThrottled(message: string, windowMs: number = DEFAULT_WINDOW_MS): void {
  const now = Date.now();
  const last = lastShownAt.get(message) ?? 0;

  if (now - last < windowMs) {
    return;
  }

  lastShownAt.set(message, now);
  toast.error(message);
}

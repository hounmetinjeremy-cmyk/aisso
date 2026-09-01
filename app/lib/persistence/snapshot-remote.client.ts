import { auth } from '~/lib/firebase.client';
import type { Snapshot } from './types';

/**
 * Snapshots de projet (code source complet) : sauvegardés sur Supabase via
 * une route serveur qui vérifie le jeton Firebase (api.snapshot.$chatId),
 * plutôt qu'en IndexedDB local — c'est ce qui saturait le stockage du
 * navigateur (chaque snapshot contient l'intégralité des fichiers du
 * projet à un instant donné).
 */

async function authHeader(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getRemoteSnapshot(chatId: string): Promise<Snapshot | undefined> {
  try {
    const res = await fetch(`/api/snapshot/${encodeURIComponent(chatId)}`, { headers: await authHeader() });

    if (!res.ok) {
      return undefined;
    }

    const data = (await res.json()) as { snapshot: Snapshot | null };

    return data.snapshot ?? undefined;
  } catch (error) {
    console.warn('[snapshot] lecture distante échouée', error);
    return undefined;
  }
}

export async function setRemoteSnapshot(chatId: string, snapshot: Snapshot): Promise<void> {
  try {
    const res = await fetch(`/api/snapshot/${encodeURIComponent(chatId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ snapshot }),
    });

    if (!res.ok) {
      console.warn('[snapshot] sauvegarde distante refusée', res.status);
    }
  } catch (error) {
    // On ne bloque jamais l'app pour un souci de sauvegarde distante.
    console.warn('[snapshot] sauvegarde distante échouée', error);
  }
}

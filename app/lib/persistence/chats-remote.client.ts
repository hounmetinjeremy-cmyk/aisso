import { auth } from '~/lib/firebase.client';

/**
 * Couche réseau partagée par db.ts et chats.ts : source de vérité Supabase
 * (table `chats`, service_role côté serveur) au lieu d'IndexedDB. Chaque
 * appel porte le jeton Firebase courant ; les routes serveur (app/routes/
 * api.chats.*, api.snapshots.*) le vérifient et scopent toute lecture/
 * écriture à l'utilisateur authentifié — jamais de user_id fourni par le
 * client pour les lectures.
 */

export interface RemoteChat {
  id: string;
  urlId?: string;
  description?: string;
  messages: any[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await auth.currentUser?.getIdToken();

  if (!token) {
    throw new Error('Non authentifié — reconnecte-toi pour accéder à ton historique.');
  }

  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json<{ error?: string }>().catch(() => ({}) as { error?: string });
    throw new Error(body.error || `Requête échouée (${res.status})`);
  }

  return res.json<T>();
}

export async function remoteListChats(): Promise<RemoteChat[]> {
  const res = await fetch('/api/chats', { headers: await authHeaders() });
  const { chats } = await parseOrThrow<{ chats: RemoteChat[] }>(res);

  return chats;
}

export async function remoteGetChat(id: string): Promise<RemoteChat | null> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { headers: await authHeaders() });
  const { chat } = await parseOrThrow<{ chat: RemoteChat | null }>(res);

  return chat;
}

export async function remoteSaveChat(
  id: string,
  messages: any[],
  urlId?: string,
  description?: string,
  timestamp?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ messages, urlId, description, timestamp, metadata }),
  });
  await parseOrThrow(res);
}

export async function remoteDeleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await authHeaders() });
  await parseOrThrow(res);
}

export async function remoteDeleteAllChats(): Promise<void> {
  const res = await fetch('/api/chats', { method: 'DELETE', headers: await authHeaders() });
  await parseOrThrow(res);
}

export async function remoteNextId(): Promise<string> {
  const res = await fetch('/api/chats/next-id', { headers: await authHeaders() });
  const { id } = await parseOrThrow<{ id: string }>(res);

  return id;
}

export async function remoteUrlId(candidate: string): Promise<string> {
  const res = await fetch(`/api/chats/url-id/${encodeURIComponent(candidate)}`, { headers: await authHeaders() });
  const { urlId } = await parseOrThrow<{ urlId: string }>(res);

  return urlId;
}

export async function remoteGetSnapshot(chatId: string): Promise<unknown | null> {
  const res = await fetch(`/api/snapshots/${encodeURIComponent(chatId)}`, { headers: await authHeaders() });
  const { snapshot } = await parseOrThrow<{ snapshot: unknown }>(res);

  return snapshot;
}

export async function remoteSetSnapshot(chatId: string, snapshot: unknown): Promise<void> {
  const res = await fetch(`/api/snapshots/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ snapshot }),
  });
  await parseOrThrow(res);
}

export async function remoteDeleteSnapshot(chatId: string): Promise<void> {
  const res = await fetch(`/api/snapshots/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  await parseOrThrow(res);
}

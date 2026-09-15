/**
 * Fonctions de gestion des conversations — Supabase (voir chats-remote.client.ts +
 * app/routes/api.chats.*), plus IndexedDB. `db` ne sert plus qu'à préserver la
 * signature pour les appelants existants (DataTab.tsx, importExportService.ts, ...).
 */

import type { UIMessage } from 'ai';
import type { IChatMetadata } from './db';
import type { PersistenceHandle } from './db';
import {
  remoteListChats,
  remoteGetChat,
  remoteSaveChat,
  remoteDeleteChat,
  remoteDeleteAllChats,
} from './chats-remote.client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface Chat {
  id: string;
  description?: string;
  messages: UIMessage[];
  timestamp: string;
  urlId?: string;
  metadata?: IChatMetadata;
}

/**
 * Get all chats from Supabase
 */
export async function getAllChats(_db: PersistenceHandle | undefined): Promise<Chat[]> {
  return (await remoteListChats()) as unknown as Chat[];
}

/**
 * Get a chat by ID
 */
export async function getChatById(_db: PersistenceHandle | undefined, id: string): Promise<Chat | null> {
  return (await remoteGetChat(id)) as unknown as Chat | null;
}

/**
 * Save a chat
 */
export async function saveChat(_db: PersistenceHandle | undefined, chat: Chat): Promise<void> {
  await remoteSaveChat(
    chat.id,
    chat.messages,
    chat.urlId,
    chat.description,
    chat.timestamp,
    chat.metadata as Record<string, unknown> | undefined,
  );
}

/**
 * Delete a chat by ID
 */
export async function deleteChat(_db: PersistenceHandle | undefined, id: string): Promise<void> {
  await remoteDeleteChat(id);
}

/**
 * Delete all chats
 */
export async function deleteAllChats(_db: PersistenceHandle | undefined): Promise<void> {
  await remoteDeleteAllChats();
}

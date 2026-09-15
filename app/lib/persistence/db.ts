import type { UIMessage } from 'ai';
import type { ChatHistoryItem } from './useChatHistory';
import type { Snapshot } from './types';
import {
  remoteListChats,
  remoteGetChat,
  remoteSaveChat,
  remoteDeleteChat,
  remoteNextId,
  remoteUrlId,
  remoteGetSnapshot,
  remoteSetSnapshot,
  remoteDeleteSnapshot,
} from './chats-remote.client';

export interface IChatMetadata {
  gitUrl: string;
  gitBranch?: string;
  netlifySiteId?: string;
}

/*
 * Source de vérité : Supabase (voir chats-remote.client.ts + app/routes/api.chats.*),
 * plus IndexedDB. Ce "handle" ne pointe plus vers une vraie connexion — il ne sert
 * plus qu'à préserver la signature des fonctions ci-dessous pour tous leurs appelants
 * existants (Menu.client.tsx, useEditChatDescription.ts, useChatHistory.ts, ...), qui
 * continuent de le passer en premier argument sans avoir besoin d'être réécrits.
 */
export type PersistenceHandle = true;

export async function openDatabase(): Promise<PersistenceHandle | undefined> {
  return true;
}

export async function getAll(_db: PersistenceHandle | undefined): Promise<ChatHistoryItem[]> {
  return (await remoteListChats()) as ChatHistoryItem[];
}

export async function setMessages(
  _db: PersistenceHandle | undefined,
  id: string,
  messages: UIMessage[],
  urlId?: string,
  description?: string,
  timestamp?: string,
  metadata?: IChatMetadata,
): Promise<void> {
  if (timestamp && isNaN(Date.parse(timestamp))) {
    throw new Error('Invalid timestamp');
  }

  await remoteSaveChat(id, messages, urlId, description, timestamp, metadata as Record<string, unknown> | undefined);
}

export async function getMessages(_db: PersistenceHandle | undefined, id: string): Promise<ChatHistoryItem> {
  const chat = await remoteGetChat(id);
  return chat as unknown as ChatHistoryItem;
}

export async function getMessagesByUrlId(_db: PersistenceHandle | undefined, id: string): Promise<ChatHistoryItem> {
  return getMessages(_db, id);
}

export async function getMessagesById(_db: PersistenceHandle | undefined, id: string): Promise<ChatHistoryItem> {
  return getMessages(_db, id);
}

export async function deleteById(_db: PersistenceHandle | undefined, id: string): Promise<void> {
  await remoteDeleteChat(id);
}

export async function getNextId(_db: PersistenceHandle | undefined): Promise<string> {
  return remoteNextId();
}

export async function getUrlId(_db: PersistenceHandle | undefined, id: string): Promise<string> {
  return remoteUrlId(id);
}

export async function forkChat(db: PersistenceHandle | undefined, chatId: string, messageId: string): Promise<string> {
  const chat = await getMessages(db, chatId);

  if (!chat) {
    throw new Error('Chat not found');
  }

  const messageIndex = chat.messages.findIndex((msg) => msg.id === messageId);

  if (messageIndex === -1) {
    throw new Error('Message not found');
  }

  const messages = chat.messages.slice(0, messageIndex + 1);

  return createChatFromMessages(db, chat.description ? `${chat.description} (fork)` : 'Forked chat', messages);
}

export async function duplicateChat(db: PersistenceHandle | undefined, id: string): Promise<string> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  return createChatFromMessages(db, `${chat.description || 'Chat'} (copy)`, chat.messages);
}

export async function createChatFromMessages(
  db: PersistenceHandle | undefined,
  description: string,
  messages: UIMessage[],
  metadata?: IChatMetadata,
): Promise<string> {
  const newId = await getNextId(db);
  const newUrlId = await getUrlId(db, newId);

  await setMessages(db, newId, messages, newUrlId, description, undefined, metadata);

  return newUrlId;
}

export async function updateChatDescription(
  db: PersistenceHandle | undefined,
  id: string,
  description: string,
): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  if (!description.trim()) {
    throw new Error('Description cannot be empty');
  }

  await setMessages(db, id, chat.messages, chat.urlId, description, chat.timestamp, chat.metadata);
}

export async function updateChatMetadata(
  db: PersistenceHandle | undefined,
  id: string,
  metadata: IChatMetadata | undefined,
): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  await setMessages(db, id, chat.messages, chat.urlId, chat.description, chat.timestamp, metadata);
}

export async function getSnapshot(_db: PersistenceHandle | undefined, chatId: string): Promise<Snapshot | undefined> {
  const snapshot = await remoteGetSnapshot(chatId);
  return (snapshot as Snapshot | null) ?? undefined;
}

export async function setSnapshot(
  _db: PersistenceHandle | undefined,
  chatId: string,
  snapshot: Snapshot,
): Promise<void> {
  await remoteSetSnapshot(chatId, snapshot);
}

export async function deleteSnapshot(_db: PersistenceHandle | undefined, chatId: string): Promise<void> {
  await remoteDeleteSnapshot(chatId);
}

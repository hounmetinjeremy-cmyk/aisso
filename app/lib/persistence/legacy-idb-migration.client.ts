import { auth } from '~/lib/firebase.client';
import { remoteSaveChat, remoteSetSnapshot } from './chats-remote.client';

/**
 * La migration Supabase (voir db.ts/chats-remote.client.ts) a arrêté de lire
 * l'ancienne base IndexedDB `boltHistory` — les conversations qui n'existaient
 * que là (créées avant ce changement) devenaient invisibles alors qu'elles
 * étaient toujours présentes dans le navigateur. Ce module les bascule une
 * seule fois vers Supabase, la nouvelle source de vérité.
 */

const MIGRATION_FLAG_KEY = 'aisso_legacy_idb_migrated_v1';

interface LegacyChatRecord {
  id: string;
  urlId?: string;
  description?: string;
  messages: any[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface LegacySnapshotRecord {
  chatId: string;
  snapshot: unknown;
}

function openLegacyDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open('boltHistory');
    request.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
    request.onerror = () => resolve(undefined);
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }

    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).getAll();

    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

async function runMigration(): Promise<void> {
  const legacyDb = await openLegacyDatabase();

  if (!legacyDb) {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
    return;
  }

  try {
    const [chats, snapshots] = await Promise.all([
      getAllFromStore<LegacyChatRecord>(legacyDb, 'chats'),
      getAllFromStore<LegacySnapshotRecord>(legacyDb, 'snapshots'),
    ]);

    for (const chat of chats) {
      try {
        await remoteSaveChat(chat.id, chat.messages ?? [], chat.urlId, chat.description, chat.timestamp, chat.metadata);
      } catch (error) {
        console.error('[legacy-migration] échec migration chat', chat.id, error);
      }
    }

    for (const snap of snapshots) {
      try {
        await remoteSetSnapshot(snap.chatId, snap.snapshot);
      } catch (error) {
        console.error('[legacy-migration] échec migration snapshot', snap.chatId, error);
      }
    }

    localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
  } finally {
    legacyDb.close();
  }
}

let migrationDonePromise: Promise<void> | null = null;

/** Idempotent : ne fait rien après la première migration réussie, et retente tant qu'aucun utilisateur n'est authentifié. */
export function ensureLegacyChatsMigrated(): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve();
  }

  if (localStorage.getItem(MIGRATION_FLAG_KEY)) {
    return Promise.resolve();
  }

  if (!auth.currentUser) {
    return Promise.resolve();
  }

  if (!migrationDonePromise) {
    migrationDonePromise = runMigration().catch((error) => {
      console.error('[legacy-migration] erreur inattendue', error);
    });
  }

  return migrationDonePromise;
}

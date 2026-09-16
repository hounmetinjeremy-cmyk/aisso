import type { SupabaseClient } from '@supabase/supabase-js';
import { WORK_DIR } from '~/utils/constants';

interface ImportedFile {
  path: string;
  content: string;
  isBinary?: boolean;
}

/**
 * Sauvegarde directement les fichiers importés/synchronisés dans le snapshot
 * Supabase de cette conversation, CÔTÉ SERVEUR — normalement c'est le
 * navigateur qui fait cette sauvegarde (voir useChatHistory.ts, takeSnapshot),
 * mais rien n'est fait si l'utilisateur quitte l'app avant que ce code
 * client ait eu le temps de tourner. Combiné à ctx.waitUntil (voir
 * api.chat.ts), ça garantit que l'import survit même dans ce cas.
 *
 * Best effort : ne doit jamais faire échouer le tour de chat si ça rate.
 */
export async function persistImportedFilesToSnapshot(
  supabase: SupabaseClient,
  userId: string,
  chatId: string,
  files: ImportedFile[],
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  try {
    const { data: existing } = await supabase
      .from('snapshots')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .maybeSingle();

    const existingSnapshot =
      (existing?.snapshot as { chatIndex?: string; files?: Record<string, unknown>; summary?: string } | null) ?? {};
    const updatedFiles: Record<string, unknown> = { ...(existingSnapshot.files ?? {}) };

    for (const file of files) {
      updatedFiles[`${WORK_DIR}/${file.path}`] = {
        type: 'file',
        content: file.content,
        isBinary: !!file.isBinary,
        isLocked: false,
      };
    }

    await supabase.from('snapshots').upsert(
      {
        user_id: userId,
        chat_id: chatId,
        snapshot: { ...existingSnapshot, files: updatedFiles },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,chat_id' },
    );
  } catch {
    // Best effort — ne bloque jamais le tour de chat pour ça.
  }
}

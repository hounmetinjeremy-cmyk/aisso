import { createClient } from '@supabase/supabase-js';

import { auth } from '~/lib/firebase.client';

/**
 * Supabase dedie a aisso (projet separe de "center") : sert uniquement a
 * sauvegarder en continu l'historique complet (conversations + modifications
 * de fichiers) pour que rien ne soit jamais perdu, meme si le navigateur est
 * ferme/vide son cache. Chaque ligne est rattachee au compte Google (Firebase
 * UID) de l'auteur — la RLS n'autorise plus que l'ecriture (jamais la
 * lecture) via la cle anon, donc l'historique d'un compte n'est jamais
 * lisible par un autre visiteur du site.
 */
const SUPABASE_URL = 'https://uvkpqgihomwgszhrapda.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2a3BxZ2lob213Z3N6aHJhcGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMjAxMjUsImV4cCI6MjEwMTY5NjEyNX0.XQincZKaSXdGc-P4qE3wCSmTwBbcb3fu5dMLrmJ0kdU';

export const aissoSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export async function logChatMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string) {
  const userId = auth.currentUser?.uid;

  if (!userId) {
    return;
  }

  try {
    await aissoSupabase.from('chat_messages').insert({ session_id: sessionId, user_id: userId, role, content });
  } catch (error) {
    // On ne bloque jamais l'app pour un souci de log : juste une trace console.
    console.warn('[aisso-history] echec sauvegarde message', error);
  }
}

export async function logFileChange(
  sessionId: string,
  filePath: string,
  content: string | null,
  changeSource: string,
) {
  const userId = auth.currentUser?.uid;

  if (!userId) {
    return;
  }

  try {
    await aissoSupabase.from('file_history').insert({
      session_id: sessionId,
      user_id: userId,
      file_path: filePath,
      content,
      change_source: changeSource,
    });
  } catch (error) {
    console.warn('[aisso-history] echec sauvegarde fichier', error);
  }
}

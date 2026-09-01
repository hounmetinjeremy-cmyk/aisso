import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';

/**
 * Sauvegarde/restauration des snapshots de projet (code source complet)
 * sur Supabase, à la place du stockage local IndexedDB qui saturait le
 * navigateur. Contrairement à chat_messages/file_history (simples logs
 * d'écriture), cette route est protégée par une vraie vérification du
 * jeton Firebase côté serveur — la table Supabase n'est accessible par
 * aucune clé publique, uniquement via service_role depuis ici.
 */

function getUidOrThrow(request: Request): Promise<string> {
  const authHeader = request.headers.get('Authorization') ?? '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  return verifyFirebaseIdToken(idToken).then((uid) => {
    if (!uid) {
      throw json({ error: 'Non authentifié.' }, { status: 401 });
    }

    return uid;
  });
}

function getServiceClient(context: LoaderFunctionArgs['context']) {
  const serviceRoleKey = (context?.cloudflare?.env as any)?.SUPABASE_SERVICE_ROLE_KEY as string | undefined;

  if (!serviceRoleKey) {
    throw json({ error: 'Sauvegarde des projets non configurée (SUPABASE_SERVICE_ROLE_KEY manquant).' }, { status: 500 });
  }

  return createClient('https://uvkpqgihomwgszhrapda.supabase.co', serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const chatId = params.chatId;

  if (!chatId) {
    return json({ error: 'chatId requis.' }, { status: 400 });
  }

  let uid: string;

  try {
    uid = await getUidOrThrow(request);
  } catch (res) {
    return res as Response;
  }

  let supabase: ReturnType<typeof createClient>;

  try {
    supabase = getServiceClient(context);
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from('snapshots')
    .select('snapshot')
    .eq('user_id', uid)
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error('[api.snapshot] lecture échouée', error);
    return json({ error: 'Échec de lecture du snapshot.' }, { status: 500 });
  }

  return json({ snapshot: data?.snapshot ?? null });
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== 'PUT' && request.method !== 'POST') {
    return json({ error: 'Méthode non supportée.' }, { status: 405 });
  }

  const chatId = params.chatId;

  if (!chatId) {
    return json({ error: 'chatId requis.' }, { status: 400 });
  }

  let uid: string;

  try {
    uid = await getUidOrThrow(request);
  } catch (res) {
    return res as Response;
  }

  let body: { snapshot?: unknown };

  try {
    body = await request.json();
  } catch {
    return json({ error: 'Corps de requête JSON invalide.' }, { status: 400 });
  }

  if (body.snapshot === undefined) {
    return json({ error: 'snapshot requis.' }, { status: 400 });
  }

  let supabase: ReturnType<typeof createClient>;

  try {
    supabase = getServiceClient(context);
  } catch (res) {
    return res as Response;
  }

  const { error } = await supabase
    .from('snapshots')
    .upsert(
      { user_id: uid, chat_id: chatId, snapshot: body.snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,chat_id' },
    );

  if (error) {
    console.error('[api.snapshot] écriture échouée', error);
    return json({ error: "Échec de l'enregistrement du snapshot." }, { status: 500 });
  }

  return json({ success: true });
}

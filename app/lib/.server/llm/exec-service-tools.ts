import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistImportedFilesToSnapshot } from '~/lib/.server/llm/persist-imported-files.server';

/**
 * Vrai terminal pour le mode "build" — via exec-service (voir
 * exec-service/README.md), un petit service Node séparé déployé sur
 * Render.com (gratuit, sans carte bancaire) car un Worker Cloudflare ne
 * peut exécuter aucune commande shell lui-même (voir
 * app/lib/webcontainer/index.ts). Un simple appel HTTPS sortant depuis ce
 * code serveur — aucun des blocages rencontrés avec WebContainer (licence
 * StackBlitz), Cloudflare Containers (payant), Codespaces/Cloud Shell
 * (API sans exécution à distance) ou l'embarquement de TypeScript/ESLint
 * dans le Worker (bundle trop gros, dépendances fs).
 *
 * N'existe que si EXEC_SERVICE_URL/EXEC_SERVICE_TOKEN sont configurés
 * (secrets Cloudflare) — sinon buildExecServiceTools renvoie {} et le
 * modèle retombe sur get_latest_workflow_runs (GitHub Actions, lecture
 * seule) déjà en place.
 */

// Généreux pour couvrir le réveil à froid du tier gratuit Render (endormi après 15 min d'inactivité, 30-60s pour se réveiller) + la commande elle-même.
const FETCH_TIMEOUT_MS = 100_000;

export function buildExecServiceTools(params: {
  execServiceUrl: string | null;
  execServiceToken: string | null;
  writer?: UIMessageStreamWriter;
  supabase?: SupabaseClient | null;
  userId?: string | null;
  chatId?: string | null;
}): ToolSet {
  const { execServiceUrl, execServiceToken, writer, supabase, userId, chatId } = params;

  if (!execServiceUrl || !execServiceToken) {
    return {};
  }

  return {
    run_command: tool({
      description:
        "Exécute une VRAIE commande shell (npm install, npm run build, npm test, lint, etc.) sur un vrai Linux et renvoie le résultat réel (stdout, stderr, code de sortie) — le seul outil de ce type disponible ici, un Worker Cloudflare ne peut pas le faire lui-même. Utilise ceci quand l'utilisateur demande de \"build/tester/vérifier/installer/lancer\" quelque chose, au lieu de deviner si ça marcherait. Le service peut mettre 30-60s à répondre s'il vient de se réveiller (tier gratuit) — c'est normal, pas un échec. Le disque (/workspace) n'est PAS garanti persistant entre deux réveils à froid : si une commande échoue car le projet n'y est plus, réimporte-le (ex: git clone) avant de réessayer.",
      inputSchema: z.object({
        command: z.string().describe('Commande shell à exécuter (ex: "npm install && npm run build")'),
        cwd: z
          .string()
          .optional()
          .describe('Dossier de travail relatif au workspace (ex: "mon-projet") — omis = racine du workspace'),
      }),
      execute: async ({ command, cwd }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const res = await fetch(`${execServiceUrl.replace(/\/$/, '')}/run`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${execServiceToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ command, cwd }),
            signal: controller.signal,
          });

          if (!res.ok) {
            return {
              message: `exec-service a répondu HTTP ${res.status} — vérifie que le service Render tourne et que le jeton est correct.`,
            };
          }

          const result = await res.json<{
            stdout: string;
            stderr: string;
            exitCode: number;
            timedOut: boolean;
            outputTruncated: boolean;
            durationMs: number;
          }>();

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            success: result.exitCode === 0,
            message: result.timedOut
              ? 'La commande a dépassé le délai autorisé côté exec-service et a été arrêtée — simplifie-la ou découpe-la.'
              : result.exitCode === 0
                ? 'Commande exécutée avec succès.'
                : `Commande terminée avec le code ${result.exitCode} — lis stderr pour la vraie cause avant de corriger.`,
          };
        } catch (error) {
          const isAbort = error instanceof Error && error.name === 'AbortError';

          return {
            message: isAbort
              ? "Pas de réponse d'exec-service dans le délai imparti — il est peut-être en train de se réveiller (tier gratuit), réessaie."
              : `Échec de l'appel à exec-service : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
    }),

    /*
     * CRITIQUE : le disque du terminal (exec-service) et l'éditeur de
     * l'utilisateur (workbenchStore, dans son navigateur) sont deux endroits
     * de stockage totalement SÉPARÉS — un `git clone`/fichier créé via
     * run_command n'apparaît JAMAIS automatiquement dans l'éditeur. Cet
     * outil est le seul pont entre les deux : il lit les fichiers réels du
     * terminal et les place dans l'éditeur, exactement comme
     * import_github_repo le fait pour un import GitHub (même mécanisme
     * `data-import-files` côté client, voir Chat.client.tsx).
     */
    sync_terminal_files_to_editor: tool({
      description:
        "Copie les fichiers RÉELS du terminal (dossier du workspace exec-service, ex: après un git clone/npm install/build ou des modifications faites via run_command) dans l'éditeur de l'utilisateur, pour qu'il les voie. Le terminal et l'éditeur sont deux endroits séparés : rien de fait via run_command n'apparaît dans l'éditeur tant que cet outil n'a pas été appelé. Appelle-le après avoir cloné/construit/modifié un projet via run_command si l'utilisateur doit voir ou garder le résultat — sinon ce travail reste invisible et perdu au prochain redémarrage à froid du service. Exclut automatiquement node_modules/.git/dist/build et assimilés. IMPORTANT sur markAsChanged : synchroniser ne pousse PAS automatiquement sur GitHub par défaut (comme importer un dépôt existant pour le consulter) — mets markAsChanged=true seulement quand ce travail est le résultat que l'utilisateur veut vraiment sauvegarder (un correctif que tu as fait, un projet construit pour lui), pour qu'il rejoigne le push automatique de fin de tour au même titre qu'un <boltAction type=\"file\">.",
      inputSchema: z.object({
        dir: z
          .string()
          .optional()
          .describe(
            'Dossier à synchroniser, relatif à la racine du workspace (ex: "mon-projet") — omis = toute la racine du workspace',
          ),
        markAsChanged: z
          .boolean()
          .optional()
          .describe(
            'true = ces fichiers rejoignent le push automatique de fin de tour, comme si tu les avais écrits via <boltAction type="file"> (utilise ça quand ce travail doit être sauvegardé). false/omis = juste visibles dans l\'éditeur, pas poussés (utilise ça pour un simple aperçu, ex: juste après un clone avant modification).',
          ),
      }),
      execute: async ({ dir, markAsChanged }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const res = await fetch(`${execServiceUrl.replace(/\/$/, '')}/tree`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${execServiceToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ dir }),
            signal: controller.signal,
          });

          if (!res.ok) {
            return {
              message: `exec-service a répondu HTTP ${res.status} en listant "${dir || '.'}" — vérifie que ce dossier existe bien dans le workspace (une commande précédente a-t-elle vraiment réussi ?).`,
            };
          }

          const result = await res.json<{
            files: { path: string; content: string; isBinary: boolean; skippedReason?: string }[];
            truncated: boolean;
          }>();

          if (result.files.length === 0) {
            return {
              message: `Aucun fichier trouvé dans "${dir || '.'}" — vérifie le chemin, ou qu'une commande précédente (ex: git clone) a bien créé quelque chose là.`,
            };
          }

          const syncedFiles = result.files.map((f) => ({ path: f.path, content: f.content, isBinary: f.isBinary }));

          writer?.write({
            type: 'data-sync-files',
            data: {
              files: syncedFiles,
              markAsChanged: markAsChanged === true,
            },
          });

          /*
           * Sauvegarde aussi directement côté serveur (voir
           * persist-imported-files.server.ts) : sans ça, si l'utilisateur
           * quitte l'app juste après cette synchro, rien de tout ce travail
           * n'est jamais sauvegardé.
           */
          if (supabase && userId && chatId) {
            persistImportedFilesToSnapshot(supabase, userId, chatId, syncedFiles).catch(() => {});
          }

          const skipped = result.files.filter((f) => f.skippedReason);

          return {
            message: `${result.files.length} fichier(s) copié(s) depuis le terminal ("${dir || '.'}") vers l'éditeur de l'utilisateur — il peut maintenant les voir. Ne réécris PAS ces fichiers via <boltAction>, ils y sont déjà.${
              markAsChanged
                ? ' Ils rejoindront le push automatique de fin de tour (markAsChanged=true).'
                : ' Non poussés automatiquement (markAsChanged=false/omis) — rappelle cet outil avec markAsChanged=true si ce travail doit être sauvegardé sur GitHub.'
            }${
              result.truncated
                ? " Le dossier est volumineux, la synchronisation s'est arrêtée avant la fin (plafond de sécurité) — relance sur un sous-dossier plus précis si besoin du reste."
                : ''
            }${skipped.length > 0 ? ` ${skipped.length} fichier(s) ignoré(s) car trop volumineux ou binaires (contenu non copié, juste le chemin).` : ''}`,
            fileCount: result.files.length,
            truncated: result.truncated,
          };
        } catch (error) {
          const isAbort = error instanceof Error && error.name === 'AbortError';

          return {
            message: isAbort
              ? "Pas de réponse d'exec-service dans le délai imparti pour lister les fichiers — réessaie."
              : `Échec de la synchronisation : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}

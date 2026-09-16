import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

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
}): ToolSet {
  const { execServiceUrl, execServiceToken } = params;

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
  };
}

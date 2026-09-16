import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/**
 * Donne au modèle un accès en LECTURE à GitHub Actions — le rôle que devait
 * jouer un vrai terminal (lancer un build/test et voir le résultat), sans
 * jamais exécuter quoi que ce soit nous-mêmes : les workflows existants du
 * dépôt (.github/workflows/ci.yaml, quality.yaml, deploy.yaml...) tournent
 * déjà automatiquement à chaque push sur `main` — pas besoin de les
 * déclencher, seulement de lire leur résultat après coup.
 *
 * IMPORTANT sur le séquencement : le push automatique après une réponse IA
 * (voir Chat.client.tsx/autoPushToGitHub) se produit APRÈS la fin de cette
 * réponse — le modèle ne peut donc pas vérifier le résultat CI de SES
 * PROPRES changements dans le même tour (le commit n'existe pas encore
 * pendant qu'il répond). Ces outils servent pour un tour ULTÉRIEUR
 * ("est-ce que ça a marché ?", "le build a échoué, répare-le").
 *
 * Utilise le même jeton que la connexion GitHub "app" (scope "repo" — voir
 * oauth-providers.server.ts) : suffisant pour lire les runs/jobs/logs
 * d'Actions, aucun scope ni jeton supplémentaire n'est nécessaire.
 */

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Aisso-App',
  };
}

// Bornes la taille du log renvoyé au modèle : un job qui échoue affiche presque toujours l'erreur vers la fin.
const MAX_LOG_CHARS = 15_000;

export function buildGithubActionsTools(params: { githubToken: string | null }): ToolSet {
  const { githubToken } = params;

  if (!githubToken) {
    return {};
  }

  return {
    get_latest_workflow_runs: tool({
      description:
        'Liste les derniers passages GitHub Actions (CI, tests, lint, déploiement) pour une branche donnée — pour vérifier si un push précédent est passé ou a échoué. Ne déclenche rien : les workflows du dépôt tournent déjà automatiquement à chaque push, cet outil lit juste leur résultat. Ne fonctionne que pour un push déjà arrivé sur GitHub (pas celui de cette même réponse — voir tes instructions système sur le séquencement du push).',
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string().describe('Branche à vérifier (ex: main)'),
      }),
      execute: async ({ owner, repo, branch }) => {
        try {
          const res = await fetch(
            `${GITHUB_API}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`,
            { headers: githubHeaders(githubToken) },
          );

          if (!res.ok) {
            return { message: `Impossible de lister les workflows (HTTP ${res.status}).` };
          }

          const data = await res.json<{
            workflow_runs: Array<{
              id: number;
              name: string;
              status: string;
              conclusion: string | null;
              html_url: string;
              head_sha: string;
              created_at: string;
            }>;
          }>();

          if (data.workflow_runs.length === 0) {
            return { message: `Aucun run GitHub Actions trouvé pour ${owner}/${repo}@${branch}.` };
          }

          return {
            runs: data.workflow_runs.map((run) => ({
              id: run.id,
              workflow: run.name,
              status: run.status, // queued | in_progress | completed
              conclusion: run.conclusion, // success | failure | cancelled | null (pas encore fini)
              url: run.html_url,
              commit: run.head_sha.slice(0, 7),
              createdAt: run.created_at,
            })),
            message:
              'Si un run a conclusion="failure", utilise get_workflow_run_failure_details avec son id pour voir ce qui a échoué avant de proposer un correctif.',
          };
        } catch (error) {
          return {
            message: `Échec de la lecture des workflows : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),
    get_workflow_run_failure_details: tool({
      description:
        'Pour un run GitHub Actions en échec (conclusion="failure", vu via get_latest_workflow_runs), renvoie quelle(s) étape(s) ont échoué et un extrait du log réel de l\'erreur — pour diagnostiquer et corriger le vrai problème au lieu de deviner.',
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        runId: z.number().describe("L'id du run (voir get_latest_workflow_runs)"),
      }),
      execute: async ({ owner, repo, runId }) => {
        try {
          const jobsRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
            headers: githubHeaders(githubToken),
          });

          if (!jobsRes.ok) {
            return { message: `Impossible de lire les jobs de ce run (HTTP ${jobsRes.status}).` };
          }

          const jobsData = await jobsRes.json<{
            jobs: Array<{
              id: number;
              name: string;
              conclusion: string | null;
              steps: Array<{ name: string; conclusion: string | null; number: number }>;
            }>;
          }>();

          const failedJobs = jobsData.jobs.filter((job) => job.conclusion === 'failure');

          if (failedJobs.length === 0) {
            return { message: "Aucun job en échec trouvé sur ce run — il n'a peut-être pas vraiment échoué." };
          }

          const details = [];

          for (const job of failedJobs) {
            const failedStep = job.steps.find((step) => step.conclusion === 'failure');

            const logRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, {
              headers: githubHeaders(githubToken),
            });

            const fullLog = logRes.ok ? await logRes.text() : null;
            const log = fullLog ? fullLog.slice(-MAX_LOG_CHARS) : null;

            details.push({
              job: job.name,
              failedStep: failedStep?.name ?? 'inconnue',
              log: log ?? '(log indisponible)',
            });
          }

          return {
            failedJobs: details,
            message:
              'Corrige la vraie cause indiquée dans le log ci-dessus (pas une supposition) avant de proposer un nouveau push.',
          };
        } catch (error) {
          return {
            message: `Échec de la lecture des logs : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),
  };
}

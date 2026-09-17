import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { WORK_DIR } from '~/utils/constants';
import type { FileMap } from '~/lib/stores/files';

/**
 * Outils "build mode" pour le compte Vercel "app" (bouton "+" -> Connecteurs,
 * le meme jeton que le bouton "Deployer sur Vercel" existant — voir
 * VercelConnection.tsx/api.connect.$provider.callback.tsx). Distinct d'un
 * serveur MCP tiers que l'utilisateur pourrait connecter separement.
 *
 * Le bouton "Deployer" existant (VercelDeploy.client.tsx) lit les fichiers
 * buildes depuis un WebContainer (`await webcontainer`, `container.fs...`) —
 * une techno retiree de ce produit (voir app/lib/webcontainer/index.ts et
 * tous les CRITICAL "no WebContainer" des prompts). Ce bouton ne peut donc
 * plus fonctionner en production. deploy_to_vercel ci-dessous n'en depend
 * pas : il utilise directement `files` (deja disponible cote serveur, voir
 * api.chat.ts) et l'endpoint /api/vercel-deploy existant (sa logique de
 * creation de projet/deploiement reste valide, seule la collecte des
 * fichiers cote client etait cassee).
 */

function stripWorkDirPrefix(fullPath: string): string {
  const prefix = `${WORK_DIR}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath.replace(/^\/+/, '');
}

/** Convertit le FileMap de l'editeur en {chemin relatif: contenu texte}, comme l'attend /api/vercel-deploy. */
function filesToSourceMap(files: FileMap): Record<string, string> {
  const sourceFiles: Record<string, string> = {};

  for (const [fullPath, dirent] of Object.entries(files)) {
    if (dirent?.type === 'file' && !dirent.isBinary) {
      sourceFiles[stripWorkDirPrefix(fullPath)] = dirent.content;
    }
  }

  return sourceFiles;
}

export function buildVercelTools(params: {
  vercelToken: string | null;
  files?: FileMap;
  chatId?: string | null;
  origin: string;
}): ToolSet {
  const { vercelToken, files, chatId, origin } = params;

  if (!vercelToken) {
    return {};
  }

  const vercelHeaders = {
    Authorization: `Bearer ${vercelToken}`,
    'Content-Type': 'application/json',
  };

  return {
    list_vercel_projects: tool({
      description:
        "Liste les projets Vercel réels du compte Vercel connecté par l'utilisateur (bouton \"+\" -> Connecteurs). Utilise ceci pour trouver l'id/nom exact d'un projet avant de vérifier son statut ou d'y déployer — ne devine jamais un nom de projet.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const res = await fetch('https://api.vercel.com/v9/projects', { headers: vercelHeaders });

          if (!res.ok) {
            return { message: `L'API Vercel a répondu HTTP ${res.status} en listant les projets.` };
          }

          const data = await res.json<{ projects: { id: string; name: string }[] }>();

          return {
            projects: data.projects.map((p) => ({ id: p.id, name: p.name, url: `https://${p.name}.vercel.app` })),
          };
        } catch (error) {
          return {
            message: `Échec de l'appel à l'API Vercel : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),

    get_vercel_deployment_status: tool({
      description:
        "Consulte le VRAI statut du dernier déploiement Vercel d'un projet (READY/ERROR/BUILDING/...) et son URL — utilise ceci après un push (si le dépôt GitHub de l'utilisateur est lié à Vercel, un push suffit à déclencher un déploiement automatique, pas besoin de deploy_to_vercel) ou après un appel à deploy_to_vercel, pour confirmer que ça a réellement fonctionné avant de dire à l'utilisateur que c'est en ligne.",
      inputSchema: z.object({
        projectId: z.string().describe('Id ou nom exact du projet Vercel (voir list_vercel_projects si inconnu)'),
      }),
      execute: async ({ projectId }) => {
        try {
          const res = await fetch(
            `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
            {
              headers: vercelHeaders,
            },
          );

          if (!res.ok) {
            return { message: `L'API Vercel a répondu HTTP ${res.status} pour le projet "${projectId}".` };
          }

          const data = await res.json<{ deployments: { uid: string; state: string; url: string }[] }>();
          const latest = data.deployments[0];

          if (!latest) {
            return { message: `Aucun déploiement trouvé pour "${projectId}" — ce projet n'a jamais été déployé.` };
          }

          return {
            state: latest.state,
            url: `https://${latest.url}`,
            message:
              latest.state === 'READY'
                ? `Déploiement réussi, en ligne sur https://${latest.url}.`
                : latest.state === 'ERROR'
                  ? `Le déploiement a échoué (state=ERROR) — utilise get_vercel_deployment_logs avec projectId="${projectId}" (ou deploymentId="${latest.uid}") pour voir l'erreur exacte, corrige le code en conséquence, puis redéploie.`
                  : `Déploiement en cours (state=${latest.state}) — pas encore terminé, ne pas encore annoncer de succès.`,
          };
        } catch (error) {
          return {
            message: `Échec de l'appel à l'API Vercel : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),

    get_vercel_deployment_logs: tool({
      description:
        "Lit les VRAIS logs de build du dernier déploiement Vercel d'un projet (ou d'un déploiement précis via deploymentId), pour voir l'erreur exacte (dépendance manquante, erreur TypeScript, commande de build qui échoue, etc.). Utilise ceci juste après get_vercel_deployment_status quand state=ERROR, AVANT de corriger le code — ne devine jamais la cause d'une erreur de build sans avoir lu ces logs. Ne couvre que les logs de BUILD, pas les logs runtime après mise en ligne.",
      inputSchema: z.object({
        projectId: z
          .string()
          .describe(
            "Id ou nom exact du projet Vercel (voir list_vercel_projects si inconnu) — ignoré si deploymentId est fourni",
          ),
        deploymentId: z
          .string()
          .optional()
          .describe('Id d’un déploiement précis à inspecter — omis = utilise le dernier déploiement du projet'),
      }),
      execute: async ({ projectId, deploymentId }) => {
        try {
          let targetId = deploymentId;

          if (!targetId) {
            const listRes = await fetch(
              `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
              { headers: vercelHeaders },
            );

            if (!listRes.ok) {
              return {
                message: `L'API Vercel a répondu HTTP ${listRes.status} en cherchant le dernier déploiement de "${projectId}".`,
              };
            }

            const listData = await listRes.json<{ deployments: { uid: string }[] }>();
            targetId = listData.deployments[0]?.uid;

            if (!targetId) {
              return { message: `Aucun déploiement trouvé pour "${projectId}" — ce projet n'a jamais été déployé.` };
            }
          }

          const res = await fetch(
            `https://api.vercel.com/v2/deployments/${encodeURIComponent(targetId)}/events?limit=400`,
            { headers: vercelHeaders },
          );

          if (!res.ok) {
            return {
              message: `L'API Vercel a répondu HTTP ${res.status} en lisant les logs du déploiement "${targetId}".`,
            };
          }

          const events = await res.json<{ type?: string; payload?: { text?: string } }[]>();
          const lines = events.map((e) => e.payload?.text).filter((text): text is string => Boolean(text?.trim()));

          if (lines.length === 0) {
            return {
              message: `Aucun log trouvé pour le déploiement "${targetId}" — le build n'a peut-être pas encore démarré, réessaie dans quelques secondes.`,
            };
          }

          const errorLines = lines.filter((l) => /error|fail|erreur|cannot find|not found|enoent|eacces/i.test(l));
          const excerpt = (errorLines.length > 0 ? errorLines : lines.slice(-60)).join('\n').slice(-6000);

          return {
            deploymentId: targetId,
            logExcerpt: excerpt,
            message:
              errorLines.length > 0
                ? `Logs récupérés pour "${targetId}" — ${errorLines.length} ligne(s) d'erreur potentielle dans logExcerpt. Corrige le code en conséquence puis redéploie (deploy_to_vercel, ou juste un push si le dépôt GitHub est lié à ce projet).`
                : `Logs récupérés pour "${targetId}" (dernières lignes dans logExcerpt) — aucune ligne d'erreur évidente détectée automatiquement, relis le texte complet pour comprendre.`,
          };
        } catch (error) {
          return {
            message: `Échec de la lecture des logs Vercel : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),

    link_github_repo_to_vercel: tool({
      description:
        "Lie un dépôt GitHub EXISTANT à un NOUVEAU projet Vercel via la vraie intégration Git de Vercel — c'est ce qui fait qu'ENSUITE, chaque push GitHub déclenche automatiquement un déploiement Vercel tout seul, sans jamais rappeler deploy_to_vercel. Utilise ceci une fois, quand l'utilisateur veut connecter/lier son dépôt GitHub à Vercel (pas juste déployer les fichiers actuels). Nécessite que Vercel ait déjà accès à ce dépôt sur GitHub (l'app GitHub de Vercel doit être installée/autorisée pour ce dépôt côté vercel.com/github.com — un préalable externe qu'aucun jeton API ne peut contourner) ; si l'appel échoue pour cette raison, dis-le clairement à l'utilisateur au lieu de réessayer en boucle.",
      inputSchema: z.object({
        owner: z.string().describe('Propriétaire du dépôt GitHub (utilisateur ou organisation)'),
        repo: z.string().describe('Nom du dépôt GitHub'),
        name: z.string().optional().describe('Nom du projet Vercel à créer — omis = utilise le nom du dépôt GitHub'),
      }),
      execute: async ({ owner, repo, name }) => {
        try {
          const res = await fetch('https://api.vercel.com/v9/projects', {
            method: 'POST',
            headers: vercelHeaders,
            body: JSON.stringify({
              name: name ?? repo,
              gitRepository: { type: 'github', repo: `${owner}/${repo}` },
            }),
          });

          const data = await res.json<{ id?: string; name?: string; error?: { message?: string; code?: string } }>();

          if (!res.ok || !data.id) {
            const rawMessage = data.error?.message ?? `HTTP ${res.status}`;
            const looksLikeAccessIssue = /reposit|permission|access|not found|introuvable/i.test(rawMessage);

            return {
              message: looksLikeAccessIssue
                ? `Vercel n'a pas accès à "${owner}/${repo}" (${rawMessage}). Ce n'est pas quelque chose qu'un jeton API peut résoudre : sur vercel.com, l'utilisateur doit d'abord autoriser l'app GitHub de Vercel pour ce dépôt précis (Vercel > Add New Project > sélectionner le dépôt, ou depuis les paramètres d'intégration GitHub de Vercel). Explique ça clairement à l'utilisateur au lieu de réessayer.`
                : `Échec de la liaison GitHub → Vercel : ${rawMessage}`,
            };
          }

          return {
            projectId: data.id,
            projectName: data.name,
            message: `Dépôt "${owner}/${repo}" lié avec succès au nouveau projet Vercel "${data.name}" (id ${data.id}). Chaque futur push sur ce dépôt déclenchera maintenant un déploiement Vercel automatique — plus besoin de deploy_to_vercel pour ce projet, juste get_vercel_deployment_status pour vérifier après un push.`,
          };
        } catch (error) {
          return {
            message: `Échec de l'appel à l'API Vercel : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),

    deploy_to_vercel: tool({
      description:
        "Déploie RÉELLEMENT le projet actuel (les vrais fichiers de l'éditeur) sur Vercel, pour de vrai — utile quand le dépôt GitHub de l'utilisateur n'est PAS lié à Vercel (sinon un simple push suffit déjà à déclencher un déploiement automatique, préfère laisser faire ça et vérifier avec get_vercel_deployment_status). Envoie tous les fichiers source à Vercel qui les build lui-même. Peut prendre jusqu'à 2 minutes (attend que le déploiement soit prêt avant de répondre).",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe('Id du projet Vercel existant à mettre à jour — omis = crée un nouveau projet'),
      }),
      execute: async ({ projectId }) => {
        if (!files) {
          return { message: 'Aucun fichier de projet disponible côté serveur pour ce tour — rien à déployer.' };
        }

        const sourceFiles = filesToSourceMap(files);

        if (Object.keys(sourceFiles).length === 0) {
          return { message: 'Aucun fichier texte trouvé dans le projet actuel — rien à déployer.' };
        }

        try {
          const res = await fetch(`${origin}/api/vercel-deploy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              files: sourceFiles,
              sourceFiles,
              token: vercelToken,
              chatId: chatId ?? `ai-deploy-${Date.now()}`,
            }),
          });

          const data = await res.json<{
            error?: string;
            deploy?: { id: string; state: string; url: string };
            project?: { id: string; name: string; url: string };
          }>();

          if (!res.ok || data.error || !data.deploy || !data.project) {
            return { message: `Échec du déploiement Vercel : ${data.error ?? `HTTP ${res.status}`}` };
          }

          return {
            projectId: data.project.id,
            projectName: data.project.name,
            state: data.deploy.state,
            url: data.deploy.url,
            message: `Déployé avec succès sur ${data.deploy.url} (projet Vercel "${data.project.name}", id ${data.project.id} — réutilise cet id pour les prochains déploiements de ce même projet).`,
          };
        } catch (error) {
          return {
            message: `Échec de l'appel à /api/vercel-deploy : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
          };
        }
      },
    }),
  };
}

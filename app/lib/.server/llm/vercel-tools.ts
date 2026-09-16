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
                  ? `Le déploiement a échoué (state=ERROR) — consulte le tableau de bord Vercel pour le détail des logs, cet outil ne les lit pas.`
                  : `Déploiement en cours (state=${latest.state}) — pas encore terminé, ne pas encore annoncer de succès.`,
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

/**
 * Outils IA (function calling) donnant à l'assistant la capacité de lister
 * et importer les dépôts GitHub connectés de l'utilisateur directement dans
 * la conversation — sans passer par le bouton manuel "Importer" du menu "+".
 *
 * Contrairement aux outils MCP (voir mcpService.ts), ceux-ci ont un
 * `execute` réel : ce sont des capacités internes de confiance (pas des
 * serveurs tiers arbitraires), elles s'exécutent donc directement dans la
 * boucle multi-étapes du SDK IA, sans confirmation manuelle de l'utilisateur.
 *
 * Le résultat renvoyé au modèle n'écrit PAS les fichiers lui-même (ça se
 * passe côté navigateur, hors de portée d'une route serveur) : il liste le
 * contenu et instruit le modèle de le recréer via des balises
 * <boltAction type="file">, le mécanisme déjà utilisé pour toute écriture de
 * fichier dans l'app (voir message-parser.ts / FilesStore).
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';
import { importRepoFiles } from '~/lib/github-import.server';

const GITHUB_API = 'https://api.github.com';

async function getGithubToken(env: Env, userId: string): Promise<string | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const supabase = getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await supabase
    .from('connected_accounts')
    .select('github_access_token')
    .eq('user_id', userId)
    .maybeSingle();

  return (data?.github_access_token as string | undefined) ?? null;
}

const MAX_TOOL_RESULT_FILES = 60;
const MAX_TOOL_RESULT_CHARS = 40_000;

/**
 * N'existe et n'est proposé au modèle que si l'utilisateur a un jeton GitHub
 * connecté — sinon absent des `tools`, pour que le modèle ne prétende jamais
 * avoir accès à un GitHub non connecté.
 */
export async function getGithubTools(env: Env, userId: string | null): Promise<ToolSet> {
  if (!userId) {
    return {};
  }

  const token = await getGithubToken(env, userId);

  if (!token) {
    return {};
  }

  return {
    list_github_repos: tool({
      description:
        "Liste les dépôts GitHub du compte connecté de l'utilisateur. À utiliser quand l'utilisateur mentionne un projet par son nom sans donner l'URL complète, pour retrouver le dépôt correspondant avant de l'importer.",
      parameters: z.object({}),
      execute: async () => {
        const res = await fetch(
          `${GITHUB_API}/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'Aisso-App',
            },
          },
        );

        if (!res.ok) {
          return { error: `Impossible de lister les dépôts (HTTP ${res.status}).` };
        }

        const repos = await res.json<
          Array<{ full_name: string; owner: { login: string }; name: string; default_branch: string; updated_at: string }>
        >();

        return {
          repos: repos.slice(0, 50).map((r) => ({
            fullName: r.full_name,
            owner: r.owner.login,
            name: r.name,
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at,
          })),
        };
      },
    }),

    import_github_repo: tool({
      description:
        "Récupère le contenu des fichiers texte d'un dépôt GitHub connecté (identifié par owner/repo, et optionnellement branch) pour l'importer dans le projet en cours. Après avoir reçu le résultat, tu DOIS recréer chacun des fichiers listés dans ta réponse avec une balise <boltAction type=\"file\" filePath=\"...\"> par fichier (même mécanisme que pour créer un fichier normalement), en reprenant leur contenu tel quel — c'est la seule façon dont les fichiers importés deviennent réellement visibles dans le projet.",
      parameters: z.object({
        owner: z.string().describe('Le propriétaire (utilisateur ou organisation) du dépôt GitHub.'),
        repo: z.string().describe('Le nom du dépôt GitHub.'),
        branch: z.string().optional().describe('La branche à importer (par défaut, la branche par défaut du dépôt).'),
      }),
      execute: async ({ owner, repo, branch }) => {
        try {
          let targetBranch = branch;

          if (!targetBranch) {
            const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Aisso-App',
              },
            });

            if (!repoRes.ok) {
              return { error: `Dépôt ${owner}/${repo} introuvable (HTTP ${repoRes.status}).` };
            }

            const repoData = await repoRes.json<{ default_branch: string }>();
            targetBranch = repoData.default_branch;
          }

          const result = await importRepoFiles(token, { owner, repo, branch: targetBranch });

          if (result.files.length === 0) {
            return { error: 'Aucun fichier texte importable dans ce dépôt.' };
          }

          // Le contexte du modèle a une limite : au-delà, on tronque plutôt
          // que de risquer une réponse coupée en plein milieu d'un fichier.
          let usedChars = 0;
          const limitedFiles: typeof result.files = [];

          for (const file of result.files.slice(0, MAX_TOOL_RESULT_FILES)) {
            usedChars += file.content.length;

            if (usedChars > MAX_TOOL_RESULT_CHARS && limitedFiles.length > 0) {
              break;
            }

            limitedFiles.push(file);
          }

          const truncatedForSize = limitedFiles.length < result.files.length;

          return {
            owner,
            repo,
            branch: targetBranch,
            files: limitedFiles,
            skipped: result.skipped + (truncatedForSize ? result.files.length - limitedFiles.length : 0),
            note: truncatedForSize
              ? "Dépôt volumineux : seuls les premiers fichiers sont inclus ici. Recrée ceux-ci d'abord, l'utilisateur peut redemander le reste ensuite."
              : undefined,
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "L'import a échoué." };
        }
      },
    }),
  };
}

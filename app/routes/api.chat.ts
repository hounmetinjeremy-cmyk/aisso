import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, type UIMessage } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { IProviderSetting } from '~/types/model';
import { type FileMap } from '~/lib/stores/files';
import type { ProgressAnnotation } from '~/types/context';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { getGithubConnectionStatus, getGithubAccessToken } from '~/lib/.server/llm/github-tools';
import { buildProjectIndexTools } from '~/lib/.server/llm/project-index-tools';
import { tryExtractMcpFileRead, captureMcpFileRead } from '~/lib/.server/llm/mcp-file-capture.server';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';
import { getSupabaseAdmin } from '~/lib/supabase-admin.server';

const logger = createScopedLogger('api.chat');

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  try {
    const body = await request.json();
    const {
      messages,
      files,
      promptId,
      contextOptimization,
      supabase,
      chatMode,
      designScheme,
      maxLLMSteps,
      mcpConfig,
      apiKeys: clientApiKeys,
      providerSettings: clientProviderSettings,
    } = body as {
      messages: UIMessage[];
      files?: FileMap;
      promptId?: string;
      contextOptimization?: boolean;
      supabase?: any;
      chatMode: 'discuss' | 'build';
      designScheme?: DesignScheme;
      maxLLMSteps?: number;
      mcpConfig?: MCPConfig;
      apiKeys?: Record<string, string>;
      providerSettings?: Record<string, IProviderSetting>;
    };

    const apiKeys = clientApiKeys || {};
    const providerSettings = clientProviderSettings || {};

    const mcpService = MCPService.getInstance();

    await mcpService.ensureConfig(mcpConfig || { mcpServers: {} }).catch((error) => {
      logger.error('mcpService.ensureConfig failed', error);
    });

    const authHeader = request.headers.get('Authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const userId = await verifyFirebaseIdToken(idToken).catch(() => null);

    const env = context.cloudflare?.env as Env | undefined;

    const [githubConnection, githubToken] = await Promise.all([
      getGithubConnectionStatus(env as any, userId).catch(() => ({
        isConnected: false,
        username: null as string | null,
      })),
      getGithubAccessToken(env as any, userId).catch(() => null),
    ]);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        let progressCounter = 1;

        /*
         * Flux d'étapes pour l'UI (voir ProgressCompilation.tsx) : chaque
         * `step-N` est d'abord écrit "in-progress", puis réécrit "complete"
         * dans onStepFinish — même label, donc l'UI remplace l'entrée au
         * lieu d'en accumuler une dupliquée. onFinish clôt toujours la
         * dernière étape, y compris pour un tour sans aucun appel d'outil.
         */
        let stepIndex = 0;

        /*
         * Même valeur par défaut que app/lib/stores/mcp.ts — ce fallback ne
         * sert que si maxLLMSteps n'a jamais été transmis (aucune requête
         * client normale ne devrait l'omettre).
         */
        const maxSteps = maxLLMSteps || 500;

        // Partagé entre analyze_github_project et la capture automatique des lectures MCP ci-dessous.
        const supabaseAdmin = env?.SUPABASE_SERVICE_ROLE_KEY ? getSupabaseAdmin(env.SUPABASE_SERVICE_ROLE_KEY) : null;

        // Construit ici (pas plus haut) pour pouvoir publier sa progression via `writer` pendant l'indexation.
        const projectIndexTools = buildProjectIndexTools({
          supabase: supabaseAdmin,
          userId,
          githubToken,
          writer,
          nextProgressOrder: () => progressCounter++,
        });

        const processedMessages = await mcpService.processToolInvocations(messages, writer);

        const filteredFiles: FileMap | undefined = files;
        let summary: string | undefined;
        let messageSliceId: number | undefined;

        if (contextOptimization && files && chatMode === 'build') {
          // context selection omitted for brevity in emergency restore — keep stream working
        }

        const options = {
          supabaseConnection: supabase,
          githubConnection,
          toolChoice: 'auto' as const,

          // Exécution serveur directe des outils MCP (résultat réel, pas "Yes, approved.") + indexation projet
          tools: { ...mcpService.tools, ...projectIndexTools },
          stopWhen: stepCountIs(maxSteps),
          onStepFinish: ({ toolCalls, toolResults }: { toolCalls: any[]; toolResults: any[] }) => {
            toolCalls.forEach((toolCall) => {
              mcpService.processToolCall(toolCall, writer);
            });

            /*
             * Sans connexion GitHub "app" (donc sans analyze_github_project), le
             * modèle lit les fichiers un par un via les outils du serveur MCP —
             * on mémorise chaque lecture reconnue au passage, sans bloquer le
             * tour de chat si l'extraction échoue (voir mcp-file-capture.server.ts).
             */
            if (supabaseAdmin && userId) {
              (toolResults || []).forEach((toolResult) => {
                const captured = tryExtractMcpFileRead(toolResult?.toolName, toolResult?.input, toolResult?.output);

                if (captured) {
                  captureMcpFileRead(supabaseAdmin, userId, captured).catch((error) => {
                    logger.error('captureMcpFileRead failed', error);
                  });
                }
              });
            }

            writer.write({
              type: 'data-progress',
              data: {
                type: 'progress',
                label: `step-${stepIndex}`,
                status: 'complete',
                order: progressCounter++,
                message:
                  toolCalls.length > 0
                    ? `Étape ${stepIndex + 1} sur ${maxSteps} : ${toolCalls.length} outil${toolCalls.length > 1 ? 's' : ''} exécuté${toolCalls.length > 1 ? 's' : ''}`
                    : `Étape ${stepIndex + 1} sur ${maxSteps} terminée`,
              } satisfies ProgressAnnotation,
            });

            stepIndex++;

            if (stepIndex < maxSteps) {
              writer.write({
                type: 'data-progress',
                data: {
                  type: 'progress',
                  label: `step-${stepIndex}`,
                  status: 'in-progress',
                  order: progressCounter++,
                  message: `Étape ${stepIndex + 1} sur ${maxSteps} en cours…`,
                } satisfies ProgressAnnotation,
              });
            }
          },
          onFinish: () => {
            writer.write({
              type: 'data-progress',
              data: {
                type: 'progress',
                label: `step-${stepIndex}`,
                status: 'complete',
                order: progressCounter++,
                message: 'Réponse terminée',
              } satisfies ProgressAnnotation,
            });
          },
        };

        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: `step-${stepIndex}`,
            status: 'in-progress',
            order: progressCounter++,
            message: `Étape 1 sur ${maxSteps} : réflexion en cours…`,
          } satisfies ProgressAnnotation,
        });

        const result = await streamText({
          messages: [...processedMessages],
          env: context.cloudflare?.env,
          options,
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          contextFiles: filteredFiles,
          chatMode,
          designScheme,
          summary,
          messageSliceId,
        });

        writer.merge(result.toUIMessageStream());
      },
      onError: (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Chat stream error', error);

        return `Custom error: ${errorMessage}`;
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error: any) {
    logger.error('chatAction failed', error?.stack || error);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    /*
     * Un corps vide (null) forçait l'UI à afficher un générique "An error
     * occurred" sans aucun indice sur la vraie cause — impossible à
     * diagnostiquer depuis les captures d'écran de l'utilisateur. On
     * remonte donc le vrai message ici.
     */
    throw new Response(error?.message || 'Internal Server Error', {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}

import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, type UIMessage } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { IProviderSetting } from '~/types/model';
import { type FileMap } from '~/lib/stores/files';
import type { ProgressAnnotation } from '~/types/context';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { getGithubConnectionStatus } from '~/lib/.server/llm/github-tools';
import { verifyFirebaseIdToken } from '~/lib/firebase-verify.server';

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

    const githubConnection = await getGithubConnectionStatus(context.cloudflare?.env as any, userId).catch(() => ({
      isConnected: false,
      username: null as string | null,
    }));

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
        const maxSteps = maxLLMSteps || 5;

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

          // Exécution serveur directe des outils MCP (résultat réel, pas "Yes, approved.")
          tools: mcpService.tools,
          stopWhen: stepCountIs(maxSteps),
          onStepFinish: ({ toolCalls }: { toolCalls: any[] }) => {
            toolCalls.forEach((toolCall) => {
              mcpService.processToolCall(toolCall, writer);
            });

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

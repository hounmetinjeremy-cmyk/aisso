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
          stopWhen: stepCountIs(maxLLMSteps || 5),
          onStepFinish: ({ toolCalls }: { toolCalls: any[] }) => {
            toolCalls.forEach((toolCall) => {
              mcpService.processToolCall(toolCall, writer);
            });
          },
        };

        writer.write({
          type: 'data-progress',
          data: {
            type: 'progress',
            label: 'response',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Generating Response',
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
    logger.error(error);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}

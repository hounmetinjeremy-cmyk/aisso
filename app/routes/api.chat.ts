import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { createScopedLogger } from '~/utils/logger';
import { getAPIKey, getBaseURL } from '~/lib/.server/llm/utils';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import type { ContextAnnotation, ProgressAnnotation, ToolCallAnnotation } from '~/types/context';
import { WORK_DIR } from '~/utils/constants';
import { createRepairTextStream } from '~/lib/.server/llm/stream-recovery';
import { SwitchableStream } from '~/lib/.server/llm/switchable-stream';
import type { DesignScheme } from '~/types/design-scheme';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { getGithubConnectionStatus } from '~/lib/.server/llm/github-tools';

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
      messages: any[];
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

    const githubConnection = await getGithubConnectionStatus(context.cloudflare?.env as any).catch(() => ({
      isConnected: false,
      username: null as string | null,
    }));

    const stream = new SwitchableStream();
    const streamRecovery = createRepairTextStream();

    const dataStream = createDataStream({
      async execute(dataStream) {
        const cumulativeUsage = {
          completionTokens: 0,
          promptTokens: 0,
          totalTokens: 0,
        };

        let progressCounter = 1;

        const processedMessages = await mcpService.processToolInvocations(messages, dataStream);

        let filteredFiles: FileMap | undefined = files;
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
          maxSteps: maxLLMSteps || 5,
          onStepFinish: ({ toolCalls }: { toolCalls: any[] }) => {
            toolCalls.forEach((toolCall) => {
              mcpService.processToolCall(toolCall, dataStream);
            });
          },
        };

        dataStream.writeData({
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation);

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

        result.mergeIntoDataStream(dataStream);
      },
      onError: (error: any) => {
        const errorMessage = error?.message || 'Unknown error';
        logger.error('Chat stream error', error);
        return `Custom error: ${errorMessage}`;
      },
    });

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  } catch (error: any) {
    logger.error(error);

    if (error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key',
        {
          status: 401,
          statusText: 'Unauthorized',
        },
      );
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}

import { getSystemPrompt } from './prompts/prompts';
import optimized from './prompts/optimized';
import { getFineTunedPrompt } from './prompts/new-prompt';
import type { DesignScheme } from '~/types/design-scheme';

export interface PromptOptions {
  cwd: string;
  allowedHtmlElements: string[];
  modificationTagName: string;
  designScheme?: DesignScheme;
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
  github?: {
    isConnected: boolean;
    username: string | null;
    hasDeployTarget?: boolean;
  };
  mcpToolsAvailable?: boolean;

  /** run_command (exec-service, voir exec-service-tools.ts) est dans les outils passés — un vrai terminal existe pour ce tour. */
  hasExecService?: boolean;

  /** deploy_to_vercel/list_vercel_projects/get_vercel_deployment_status (voir vercel-tools.ts) — compte Vercel "app" connecté. */
  hasVercelConnected?: boolean;
}

export class PromptLibrary {
  static library: Record<
    string,
    {
      label: string;
      description: string;
      get: (options: PromptOptions) => string;
    }
  > = {
    default: {
      label: 'Default Prompt',
      description: 'An fine tuned prompt for better results and less token usage',
      get: (options) =>
        getFineTunedPrompt(
          options.cwd,
          options.supabase,
          options.designScheme,
          options.github,
          options.mcpToolsAvailable,
          options.hasExecService,
          options.hasVercelConnected,
        ),
    },
    original: {
      label: 'Old Default Prompt',
      description: 'The OG battle tested default system Prompt',
      get: (options) =>
        getSystemPrompt(
          options.cwd,
          options.supabase,
          options.designScheme,
          options.github,
          options.mcpToolsAvailable,
          options.hasExecService,
          options.hasVercelConnected,
        ),
    },
    optimized: {
      label: 'Optimized Prompt (experimental)',
      description: 'An Experimental version of the prompt for lower token usage',
      get: (options) => optimized(options),
    },
  };

  static getList() {
    return Object.entries(this.library).map(([key, value]) => {
      const { label, description } = value;
      return {
        id: key,
        label,
        description,
      };
    });
  }

  /** Correct spelling (was getPropmtFromLibrary — typo that crashed chat). */
  static getPromptFromLibrary(promptId: string, options: PromptOptions) {
    const prompt = this.library[promptId];

    if (!prompt) {
      throw new Error(`Prompt not found: ${promptId}`);
    }

    return this.library[promptId]?.get(options);
  }

  /** @deprecated typo alias kept for any residual callers */
  static getPropmtFromLibrary(promptId: string, options: PromptOptions) {
    return this.getPromptFromLibrary(promptId, options);
  }
}

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export default class GroqProvider extends BaseProvider {
  name = 'Groq';
  getApiKeyLink = 'https://console.groq.com/keys';

  config = {
    apiTokenKey: 'GROQ_API_KEY',
  };

  staticModels: ModelInfo[] = [
    /*
     * Essential fallback models, utilisés seulement si aucune clé API Groq
     * n'est configurée (sinon getDynamicModels() ci-dessous récupère la
     * vraie liste à jour depuis l'API). 2e remplacement en date : la
     * génération Llama 4 (Scout/Maverick) qui remplaçait déjà Llama 3.x a
     * été dépréciée à son tour par Groq (Maverick le 20/02/2026, Scout le
     * 17/06/2026 — plus servi du tout depuis août 2026, voir
     * https://console.groq.com/docs/deprecations). Remplacés par les modèles
     * que Groq recommande explicitement en migration : gpt-oss (OpenAI open
     * weights) et Qwen3.
     *
     * Impossible de vérifier ces noms en direct depuis cet environnement
     * (accès réseau vers api.groq.com bloqué ici). Si ces noms sont eux
     * aussi obsolètes au moment où quelqu'un lit ceci, se fier à
     * https://console.groq.com/docs/models ou à la liste déroulante réelle
     * de l'app (alimentée par getDynamicModels) plutôt qu'à ce secours codé
     * en dur.
     */
    {
      name: 'openai/gpt-oss-120b',
      label: 'GPT-OSS 120B',
      provider: 'Groq',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 8192,
    },
    {
      name: 'openai/gpt-oss-20b',
      label: 'GPT-OSS 20B',
      provider: 'Groq',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 8192,
    },
    {
      name: 'qwen/qwen3.6-27b',
      label: 'Qwen3.6 27B',
      provider: 'Groq',
      maxTokenAllowed: 128000,
      maxCompletionTokens: 8192,
    },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ): Promise<ModelInfo[]> {
    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'GROQ_API_KEY',
    });

    if (!apiKey) {
      throw `Missing Api Key configuration for ${this.name} provider`;
    }

    const response = await fetch(`https://api.groq.com/openai/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const res = (await response.json()) as any;

    const data = res.data.filter(
      (model: any) => model.object === 'model' && model.active && model.context_window > 8000,
    );

    return data.map((m: any) => ({
      name: m.id,
      label: `${m.id} - context ${m.context_window ? Math.floor(m.context_window / 1000) + 'k' : 'N/A'} [ by ${m.owned_by}]`,
      provider: this.name,
      maxTokenAllowed: Math.min(m.context_window || 8192, 16384),
      maxCompletionTokens: 8192,
    }));
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'GROQ_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const openai = createOpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey,
    });

    return openai(model);
  }
}

import { useStore } from '@nanostores/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { toastErrorThrottled } from '~/utils/throttledToastError';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { description, useChatHistory } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import { getApiKeysFromCookies } from './APIKeyManager';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { TextUIPart, FileUIPart } from 'ai';
import { useMCPStore } from '~/lib/stores/mcp';
import type { AppendMessage } from './appendMessage';
import type { LlmErrorAlertType } from '~/types/actions';
import { useAuth } from '~/lib/hooks/useAuth.client';
import { loadSelectedRepo, saveSelectedRepo, useDeployToGitHub } from '~/lib/hooks/useDeployToGitHub.client';

const logger = createScopedLogger('Chat');

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  return (
    <>
      {ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: UIMessage[];
    initialMessages: UIMessage[];
    isLoading: boolean;
    parseMessages: (messages: UIMessage[], isLoading: boolean) => void;
    storeMessageHistory: (messages: UIMessage[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toastErrorThrottled(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: UIMessage[];
  storeMessageHistory: (messages: UIMessage[]) => Promise<void>;
  importChat: (description: string, messages: UIMessage[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, importChat, exportChat }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);
    const [designScheme, setDesignScheme] = useState<DesignScheme>(defaultDesignScheme);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection);
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);
    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });
    const { showChat } = useStore(chatStore);
    const [animationScope, animate] = useAnimate();
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [chatMode, setChatMode] = useState<'discuss' | 'build'>('build');
    const mcpSettings = useMCPStore((state) => state.settings);
    const { user: authUser } = useAuth();
    const [firebaseIdToken, setFirebaseIdToken] = useState<string | undefined>(undefined);
    const { deploy: deployToGitHub } = useDeployToGitHub();

    /*
     * Jeton Firebase transmis au backend pour les outils IA qui ont besoin de
     * savoir "qui" pose la question (ex. importer un dépôt GitHub connecté) —
     * rafraîchi périodiquement car un jeton Firebase expire au bout d'1h.
     */
    useEffect(() => {
      if (!authUser) {
        setFirebaseIdToken(undefined);
        return undefined;
      }

      let cancelled = false;

      const refresh = () => {
        authUser
          .getIdToken()
          .then((token) => {
            if (!cancelled) {
              setFirebaseIdToken(token);
            }
          })
          .catch(() => {});
      };

      refresh();

      const interval = setInterval(refresh, 30 * 60 * 1000);

      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }, [authUser]);

    /*
     * Pousse automatiquement vers GitHub les fichiers modifiés par l'IA
     * pendant ce tour de chat — plus de terminal/aperçu visuel, seul un
     * message de statut confirme ce qui a été fait (voir plan
     * "suppression WebContainer/Terminal/Aperçu").
     */
    const autoPushToGitHub = useCallback(async () => {
      try {
        /*
         * Le parsing du dernier morceau de la réponse (qui écrit les
         * derniers fichiers dans FilesStore) est échantillonné à 50ms
         * (voir processSampledMessages/createSampler) et déclenché par un
         * useEffect sur `messages`, qui ne s'exécute pas forcément avant ce
         * callback onFinish (asynchrone par rapport au cycle de rendu React).
         * On laisse une marge confortable pour que ce dernier parsing ait
         * eu lieu avant de figer la liste des fichiers touchés.
         */
        await new Promise((resolve) => setTimeout(resolve, 150));
        await workbenchStore.flushPendingActions();

        const touchedFiles = workbenchStore.takeFilesTouchedThisTurn();

        if (touchedFiles.length === 0) {
          return;
        }

        const target = loadSelectedRepo();

        if (!target) {
          /*
           * Testé en réel : le modèle affirme systématiquement (instruction
           * système) que les fichiers sont "automatiquement poussés sur
           * GitHub" — vrai seulement si un dépôt cible a déjà été choisi
           * pour CETTE conversation (bouton Déployer, ou import manuel qui
           * l'enregistre déjà). Sans ça, ce retour restait totalement
           * silencieux : aucun push, aucune erreur, l'utilisateur découvrait
           * un dépôt vide bien plus tard sans aucun indice.
           */
          const hasMcpServersConfigured = Object.keys(mcpSettings.mcpConfig?.mcpServers ?? {}).length > 0;

          toast.warning(
            `${touchedFiles.length} fichier${touchedFiles.length > 1 ? 's' : ''} modifié${touchedFiles.length > 1 ? 's' : ''}, mais aucun dépôt GitHub choisi pour cette conversation — ce push automatique ne s'applique qu'à la connexion GitHub "app" (bouton Déployer). ${
              hasMcpServersConfigured
                ? "Si tu comptes sur ton serveur MCP pour pousser, vérifie dans la réponse que l'IA a bien appelé son outil d'écriture GitHub."
                : 'Utilise le bouton Déployer pour choisir un dépôt.'
            }`,
          );

          return;
        }

        const preview = touchedFiles.slice(0, 3).join(', ');
        const suffix = touchedFiles.length > 3 ? '…' : '';
        const commitMessage = `Aïsso : mise à jour de ${touchedFiles.length} fichier${touchedFiles.length > 1 ? 's' : ''} — ${preview}${suffix}`;

        const result = await deployToGitHub(target, commitMessage);

        toast.success(`Poussé sur GitHub (commit ${result.commitSha.slice(0, 7)}).`);
      } catch (error) {
        logger.error('Auto-push GitHub failed', error);
        toast.error('Le push automatique vers GitHub a échoué.');
      }
    }, [deployToGitHub, mcpSettings]);

    const [input, setInput] = useState(Cookies.get(PROMPT_COOKIE_KEY) || '');
    const [chatData, setChatData] = useState<unknown[]>([]);

    const handleInputChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(event.target.value);
    }, []);

    const {
      messages,
      status,
      stop,
      sendMessage: sendChatMessage,
      setMessages,
      regenerate,
      error,
    } = useChat({
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({
          /*
           * useChat (v5) ne recrée pas son transport à chaque render — cette
           * fonction reste celle créée au montage, avec `apiKeys` figé à sa
           * valeur de l'époque (souvent {}). On relit donc le cookie à
           * chaque appel plutôt que de fermer sur l'état React, sinon une
           * clé API ajoutée après le montage du chat n'est jamais envoyée
           * au serveur (l'UI la montre pourtant comme configurée).
           */
          apiKeys: getApiKeysFromCookies(),
          files,
          promptId,
          contextOptimization: contextOptimizationEnabled,
          chatMode,
          designScheme,

          /*
           * Un dépôt GitHub connecté (OAuth) ne veut pas dire qu'un dépôt CIBLE
           * a été choisi pour CETTE conversation — le push automatique de fin
           * de tour (voir autoPushToGitHub) ne se déclenche que si c'est le
           * cas. Sans cette info, le prompt système affirmait sans condition
           * que "les fichiers sont automatiquement poussés", ce qui induisait
           * l'utilisateur en erreur quand aucun dépôt cible n'était choisi.
           */
          hasDeployTarget: !!loadSelectedRepo(),
          supabase: {
            isConnected: supabaseConn.isConnected,
            hasSelectedProject: !!selectedProject,
            credentials: {
              supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
              anonKey: supabaseConn?.credentials?.anonKey,
            },
          },
          maxLLMSteps: mcpSettings.maxLLMSteps,
          mcpConfig: mcpSettings.mcpConfig,
          firebaseIdToken,
        }),
      }),
      onError: (e) => {
        setFakeLoading(false);
        handleError(e, 'chat');
      },
      onData: (dataPart) => {
        /*
         * Écrit directement dans workbenchStore (même mécanisme que l'import
         * manuel, voir useDeployToGitHub.client.ts) au lieu de faire recopier
         * le contenu par le modèle via des boltAction — voir
         * github-import-tools.ts. Évite toute limite liée à la fenêtre de
         * sortie du modèle : le serveur streame le contenu réel une seule
         * fois, jamais retapé.
         */
        if ((dataPart as any).type === 'data-import-files') {
          const { owner, repo, branch, files } = (dataPart as any).data as {
            owner: string;
            repo: string;
            branch: string;
            files: { path: string; content: string; isBinary?: boolean }[];
          };

          void workbenchStore.createFiles(
            files.map((file) => ({ path: `${WORK_DIR}/${file.path}`, content: file.content, isBinary: file.isBinary })),
            'import',
          );

          /*
           * Sans ça, le push automatique de fin de tour (autoPushToGitHub,
           * plus bas) resterait sans dépôt cible malgré cet import déclenché
           * depuis le chat — l'utilisateur devrait quand même repasser par le
           * bouton Déployer pour choisir MANUELLEMENT le dépôt qu'il vient
           * pourtant d'ouvrir ici.
           */
          saveSelectedRepo({ owner, repo, branch });

          return;
        }

        /*
         * Le disque du terminal (exec-service) et l'éditeur sont deux
         * emplacements séparés (voir exec-service-tools.ts,
         * sync_terminal_files_to_editor) — ceci est le seul pont entre les
         * deux. Contrairement à data-import-files, aucun dépôt GitHub n'est
         * forcément impliqué (le terminal peut construire quelque chose qui
         * n'existe encore nulle part sur GitHub), donc pas de
         * saveSelectedRepo ici.
         */
        if ((dataPart as any).type === 'data-sync-files') {
          const { files, markAsChanged } = (dataPart as any).data as {
            files: { path: string; content: string; isBinary?: boolean }[];
            markAsChanged?: boolean;
          };

          const fullPaths = files.map((file) => `${WORK_DIR}/${file.path}`);

          void workbenchStore.createFiles(
            files.map((file, i) => ({ path: fullPaths[i], content: file.content, isBinary: file.isBinary })),
            'terminal-sync',
          );

          /*
           * Sans ça, ce travail resterait visible dans l'éditeur mais jamais
           * poussé par autoPushToGitHub (plus bas), qui ne lit que les
           * fichiers marqués "touchés" — voir markAsChanged dans
           * exec-service-tools.ts.
           */
          if (markAsChanged) {
            workbenchStore.markFilesTouched(fullPaths);
          }

          return;
        }

        setChatData((prev) => [...prev, dataPart]);
      },
      onFinish: () => {
        setChatData([]);
        logger.debug('Finished streaming');
        autoPushToGitHub();
      },
    });

    const isLoading = status === 'submitted' || status === 'streaming';

    /*
     * Adaptateur vers l'ancienne forme `append({role, content: [...]})` (v4)
     * encore utilisée par quelques call-sites secondaires (liens "actions
     * rapides" dans le markdown rendu) — évite de retoucher tout le
     * threading de props (BaseChat -> Messages -> AssistantMessage ->
     * Markdown) pour la nouvelle API `sendMessage`.
     */
    const append = useCallback(
      (message: AppendMessage) => {
        const text = message.content.map((part) => part.text).join('\n');
        sendChatMessage({ text, messageId: message.id });
      },
      [sendChatMessage],
    );

    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        setSearchParams({});
        runAnimation();
        sendChatMessage({ text: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}` });
      }
    }, [model, provider, searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    useEffect(() => {
      chatStore.setKey('started', initialMessages.length > 0);
    }, []);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    const handleError = useCallback(
      (error: any, context: 'chat' | 'template' | 'llmcall' = 'chat') => {
        logger.error(`${context} request failed`, error);

        stop();
        setFakeLoading(false);

        let errorInfo = {
          message: 'An unexpected error occurred',
          isRetryable: true,
          statusCode: 500,
          provider: provider.name,
          type: 'unknown' as const,
          retryDelay: 0,
        };

        if (error.message) {
          try {
            const parsed = JSON.parse(error.message);

            if (parsed.error || parsed.message) {
              errorInfo = { ...errorInfo, ...parsed };
            } else {
              errorInfo.message = error.message;
            }
          } catch {
            errorInfo.message = error.message;
          }
        }

        let errorType: LlmErrorAlertType['errorType'] = 'unknown';
        let title = 'Request Failed';

        if (errorInfo.statusCode === 401 || errorInfo.message.toLowerCase().includes('api key')) {
          errorType = 'authentication';
          title = 'Authentication Error';
        } else if (errorInfo.statusCode === 429 || errorInfo.message.toLowerCase().includes('rate limit')) {
          errorType = 'rate_limit';
          title = 'Rate Limit Exceeded';
        } else if (errorInfo.message.toLowerCase().includes('quota')) {
          errorType = 'quota';
          title = 'Quota Exceeded';
        } else if (errorInfo.statusCode >= 500) {
          errorType = 'network';
          title = 'Server Error';
        }

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description: errorInfo.message,
          provider: provider.name,
          errorType,
        });
        setChatData([]);
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    // Helper function to create message parts array from text and images
    const createMessageParts = (text: string, images: string[] = []): Array<TextUIPart | FileUIPart> => {
      // Create an array of properly typed message parts
      const parts: Array<TextUIPart | FileUIPart> = [
        {
          type: 'text',
          text,
        },
      ];

      // Add image parts if any
      images.forEach((imageData) => {
        // Extract correct MIME type from the data URL
        const mediaType = imageData.split(';')[0].split(':')[1] || 'image/jpeg';

        // Create file part according to AI SDK v5 format (full data: URL, not bare base64)
        parts.push({
          type: 'file',
          mediaType,
          url: imageData,
        });
      });

      return parts;
    };

    // Helper function to convert File[] to FileUIPart[] for AI SDK v5
    const filesToAttachments = async (files: File[]): Promise<FileUIPart[] | undefined> => {
      if (files.length === 0) {
        return undefined;
      }

      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<FileUIPart>((resolve) => {
              const reader = new FileReader();

              reader.onloadend = () => {
                resolve({
                  type: 'file',
                  filename: file.name,
                  mediaType: file.type,
                  url: reader.result as string,
                });
              };
              reader.readAsDataURL(file);
            }),
        ),
      );

      return attachments;
    };

    const sendMessage = async (_event: React.UIEvent, messageInput?: string) => {
      const messageContent = messageInput || input;

      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      const finalMessageContent = messageContent;

      /*
       * `mcpSettings` (lu via le hook plus haut) peut être encore la valeur par
       * défaut (mcpServers: {}) si ce composant vient de monter : useMCPStore
       * initialise sa config en async (fetch réseau) et le premier message
       * d'une session fraîche peut partir AVANT que ça se termine — le
       * serveur reçoit alors une config MCP vide et répond "aucun outil MCP
       * connecté". On force l'attente ici, puis on relit le store à jour
       * (plutôt que la closure `mcpSettings`, qui resterait périmée le temps
       * de ce rendu) pour l'injecter explicitement dans le body de la requête.
       */
      if (!useMCPStore.getState().isInitialized) {
        await useMCPStore.getState().initialize();
      }

      const freshMcpSettings = useMCPStore.getState().settings;
      const mcpRequestBody = {
        mcpConfig: freshMcpSettings.mcpConfig,
        maxLLMSteps: freshMcpSettings.maxLLMSteps,
      };

      runAnimation();

      if (!chatStarted) {
        setFakeLoading(true);

        if (autoSelectTemplate) {
          const { template, title } = await selectStarterTemplate({
            message: finalMessageContent,
            model,
            provider,
          });

          if (template !== 'blank') {
            const temResp = await getTemplates(template, title).catch((e) => {
              if (e.message.includes('rate limit')) {
                toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
              } else {
                toast.warning('Failed to import starter template\n Continuing with blank template');
              }

              return null;
            });

            if (temResp) {
              const { assistantMessage, userMessage } = temResp;
              const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
              const templateAttachments =
                uploadedFiles.length > 0 ? ((await filesToAttachments(uploadedFiles)) ?? []) : [];

              setMessages([
                {
                  id: `1-${new Date().getTime()}`,
                  role: 'user',
                  parts: [...createMessageParts(userMessageText, imageDataList), ...templateAttachments],
                },
                {
                  id: `2-${new Date().getTime()}`,
                  role: 'assistant',
                  parts: [{ type: 'text', text: assistantMessage }],
                },
                {
                  id: `3-${new Date().getTime()}`,
                  role: 'user',
                  parts: [
                    { type: 'text', text: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userMessage}` },
                  ],
                  metadata: { hidden: true },
                },
              ]);

              regenerate({ body: mcpRequestBody });
              setInput('');
              Cookies.remove(PROMPT_COOKIE_KEY);

              setUploadedFiles([]);
              setImageDataList([]);

              resetEnhancer();

              textareaRef.current?.blur();
              setFakeLoading(false);

              return;
            }
          }
        }

        // If autoSelectTemplate is disabled or template selection failed, proceed with normal message
        const userMessageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
        const attachments = uploadedFiles.length > 0 ? ((await filesToAttachments(uploadedFiles)) ?? []) : [];

        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            parts: [...createMessageParts(userMessageText, imageDataList), ...attachments],
          },
        ]);
        regenerate({ body: mcpRequestBody });
        setFakeLoading(false);
        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();

        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();

      chatStore.setKey('aborted', false);

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${finalMessageContent}`;
        const attachments = uploadedFiles.length > 0 ? ((await filesToAttachments(uploadedFiles)) ?? []) : [];

        sendChatMessage(
          { role: 'user', parts: [...createMessageParts(messageText, imageDataList), ...attachments] },
          { body: mcpRequestBody },
        );

        workbenchStore.resetAllFileModifications();
      } else {
        const messageText = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${finalMessageContent}`;
        const attachments = uploadedFiles.length > 0 ? ((await filesToAttachments(uploadedFiles)) ?? []) : [];

        sendChatMessage(
          { role: 'user', parts: [...createMessageParts(messageText, imageDataList), ...attachments] },
          { body: mcpRequestBody },
        );
      }

      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);

      setUploadedFiles([]);
      setImageDataList([]);

      resetEnhancer();

      textareaRef.current?.blur();
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    const handleWebSearchResult = useCallback(
      (result: string) => {
        const currentInput = input || '';
        const newInput = currentInput.length > 0 ? `${result}\n\n${currentInput}` : result;

        // Update the input via the same mechanism as handleInputChange
        const syntheticEvent = {
          target: { value: newInput },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);
      },
      [input, handleInputChange],
    );

    return (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={description}
        importChat={importChat}
        exportChat={exportChat}
        messages={messages}
        parsedMessages={parsedMessages}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        supabaseAlert={supabaseAlert}
        clearSupabaseAlert={() => workbenchStore.clearSupabaseAlert()}
        deployAlert={deployAlert}
        clearDeployAlert={() => workbenchStore.clearDeployAlert()}
        llmErrorAlert={llmErrorAlert}
        clearLlmErrorAlert={clearApiErrorAlert}
        data={chatData}
        chatMode={chatMode}
        setChatMode={setChatMode}
        append={append}
        designScheme={designScheme}
        setDesignScheme={setDesignScheme}
        onWebSearchResult={handleWebSearchResult}
      />
    );
  },
);

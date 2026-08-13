import type { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { workbenchStore } from '~/lib/stores/workbench';
import { RemoteContainer, getOrCreateContainerSessionId } from './remote-container-client';

interface WebContainerContext {
  loaded: boolean;
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

/**
 * `webcontainer` garde le même nom et la même forme (`Promise<WebContainer>`)
 * qu'avant la migration : c'est ce qui permet à tous les autres fichiers
 * (files.ts, previews.ts, action-runner.ts, useGit.ts, shell.ts...) de
 * continuer à fonctionner SANS modification. Ce qui change, c'est ce que
 * cette promesse résout : plus une instance @webcontainer/api tournant dans
 * le navigateur, mais un RemoteContainer qui pilote un vrai conteneur Docker
 * distant sur Cloudflare (voir remote-container-client.ts + /container).
 *
 * `RemoteContainer` n'implémente que le sous-ensemble de l'API WebContainer
 * réellement utilisé ailleurs dans le repo (voir le commentaire en tête de
 * remote-container-client.ts) ; le cast `as unknown as WebContainer` reflète
 * ce duck-typing volontairement partiel.
 */
export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

if (!import.meta.env.SSR) {
  webcontainer =
    import.meta.hot?.data.webcontainer ??
    Promise.resolve()
      .then(() => {
        return RemoteContainer.boot({
          workdirName: WORK_DIR_NAME,
          sessionId: getOrCreateContainerSessionId(),
        });
      })
      .then(async (remoteContainer) => {
        webcontainerContext.loaded = true;

        // TODO(phase 2.1) : le script d'inspection (capture des erreurs JS
        // dans l'iframe de preview) n'est pas encore relayé au conteneur
        // distant — voir remote-container-client.ts#setPreviewScript et
        // container/README.md. En attendant, les erreurs runtime de l'app
        // prévisualisée ne remontent pas automatiquement dans le chat.
        const response = await fetch('/inspector-script.js');
        const inspectorScript = await response.text();
        await remoteContainer.setPreviewScript(inspectorScript);

        remoteContainer.on('preview-message', (message: any) => {
          console.log('[RemoteContainer] preview message:', message);

          if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
            const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
            const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
            workbenchStore.actionAlert.set({
              type: 'preview',
              title,
              description: 'message' in message ? message.message : 'Unknown error',
              content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}`,
              source: 'preview',
            });
          }
        });

        return remoteContainer as unknown as WebContainer;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}

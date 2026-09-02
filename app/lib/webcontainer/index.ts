interface WebContainerContext {
  loaded: boolean;
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: true,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

/**
 * `webcontainer` ne pilote plus AUCUN conteneur reel (ni local, ni distant
 * sur Cloudflare) : le conteneur distant est payant, et l'app ne peut plus
 * se permettre cette depense. Tous les fichiers qui recevaient auparavant
 * cette promesse (files.ts, previews.ts, action-runner.ts, terminal.ts...)
 * ont deja ete mis a jour pour ne plus en dependre reellement (ils gardent
 * juste le parametre pour rester compatibles) : cette promesse ne sert donc
 * plus qu'a satisfaire ces signatures existantes, sans jamais rien booter.
 */
export const webcontainer: Promise<any> = Promise.resolve({});

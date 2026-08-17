/**
 * Worker isole, dedie uniquement aux Cloudflare Containers (terminal/build distant).
 * Separe du Worker principal aisso pour eviter le bug de bundling wrangler +
 * @cloudflare/containers quand combine avec l'enorme graphe de dependances de
 * l'app (IA SDKs, CodeMirror, etc.). Le Worker principal appelle celui-ci via
 * un Service Binding (voir CONTAINER_SERVICE dans le wrangler.toml principal).
 *
 * Route attendue (deja prefixee par le Worker principal, prefixe conserve ici) :
 *   /api/container/<sessionId>/<...reste> -> UserContainer correspondant,
 *   en ne transmettant que <...reste>.
 */
import { getContainer } from '@cloudflare/containers';
export { UserContainer } from './user-container';

interface Env {
  USER_CONTAINER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean); // ['api', 'container', sessionId, ...rest]
      const sessionId = segments[2];

      if (!sessionId) {
        return new Response("sessionId manquant dans l'URL", { status: 400 });
      }

      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = '/' + segments.slice(3).join('/');

      const forwardedRequest = new Request(forwardedUrl, request);
      const instance = getContainer(env.USER_CONTAINER, sessionId);

      return instance.fetch(forwardedRequest);
    } catch (error) {
      console.error('[aisso-container] erreur non gérée :', error);
      return new Response('Erreur interne du conteneur', { status: 500 });
    }
  },
};

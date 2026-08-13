/**
 * Squelette (phase 2, non branché) de la Durable Object qui pilotera le
 * conteneur distant remplaçant WebContainer.
 *
 * À importer et exporter depuis workers/app.ts une fois prêt :
 *   export { UserContainer } from '../container/user-container';
 *
 * Et à activer dans wrangler.toml (bloc actuellement commenté).
 */
import { Container, switchPort } from '@cloudflare/containers';

// Doit correspondre à AGENT_PORT dans container/agent/server.mjs et Dockerfile.
const AGENT_PORT = 8081;

export class UserContainer extends Container {
  defaultPort = AGENT_PORT;

  // Éteint le conteneur après 10 min d'inactivité pour limiter les coûts
  // (facturation Cloudflare Containers = à l'usage, tant que ça dort ça ne coûte rien).
  sleepAfter = '10m';

  override onStart() {
    console.log('[UserContainer] conteneur démarré');
  }

  override onStop() {
    console.log('[UserContainer] conteneur arrêté');
  }

  override onError(error: unknown) {
    console.error('[UserContainer] erreur :', error);
  }

  /**
   * Reçoit les requêtes déjà "dérivées" par workers/app.ts pour cette
   * session (préfixe /api/container/<sessionId>/ retiré, voir routeToContainer).
   * Deux types de trafic :
   *   - /agent-ws         : canal de contrôle WebSocket (fs/exec/watch)
   *   - /preview/<port>/* : reverse-proxy vers le serveur de dev de l'app générée
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const previewMatch = url.pathname.match(/^\/preview\/(\d+)(\/.*)?$/);

    if (previewMatch) {
      const port = Number(previewMatch[1]);
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = previewMatch[2] || '/';

      const forwardedRequest = new Request(forwardedUrl, request);

      if (request.headers.get('Upgrade') === 'websocket') {
        // containerFetch() ne supporte pas les WebSockets (ex: HMR Vite) :
        // il faut passer par fetch() + switchPort(). On appelle super.fetch()
        // (l'implémentation de base de @cloudflare/containers), PAS this.fetch(),
        // pour ne pas boucler sur notre propre override.
        return super.fetch(switchPort(forwardedRequest, port));
      }

      return this.containerFetch(forwardedRequest, port);
    }

    if (url.pathname === '/agent-ws') {
      // WebSocket, donc fetch() (pas containerFetch()) ; AGENT_PORT est déjà
      // defaultPort donc pas besoin de switchPort ici. super.fetch(), pas
      // this.fetch(), pour éviter la récursion infinie sur notre override.
      return super.fetch(request);
    }

    return new Response('Route de conteneur inconnue', { status: 404 });
  }
}

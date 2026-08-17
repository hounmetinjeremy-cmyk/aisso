/**
 * Copie isolee de container/user-container.ts, specifique a ce Worker separe.
 * Voir container/user-container.ts (Worker principal) pour le commentaire
 * d'origine ; ce fichier doit rester identique.
 */
import { Container, switchPort } from '@cloudflare/containers';

// Doit correspondre a AGENT_PORT dans container/agent/server.mjs et Dockerfile.
const AGENT_PORT = 8081;

export class UserContainer extends Container {
  defaultPort = AGENT_PORT;

  // Eteint le conteneur apres 10 min d'inactivite pour limiter les couts
  // (facturation Cloudflare Containers = a l'usage, tant que ca dort ca ne coute rien).
  sleepAfter = '10m';

  override onStart() {
    console.log('[UserContainer] conteneur demarre');
  }

  override onStop() {
    console.log('[UserContainer] conteneur arrete');
  }

  override onError(error: unknown) {
    console.error('[UserContainer] erreur :', error);
  }

  /**
   * Recoit les requetes deja "derivees" par ce Worker isole pour cette
   * session (prefixe /api/container/<sessionId>/ retire, voir src/index.ts).
   * Deux types de trafic :
   *   - /agent-ws         : canal de controle WebSocket (fs/exec/watch)
   *   - /preview/<port>/* : reverse-proxy vers le serveur de dev de l'app generee
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
        // (l'implementation de base de @cloudflare/containers), PAS this.fetch(),
        // pour ne pas boucler sur notre propre override.
        return super.fetch(switchPort(forwardedRequest, port));
      }

      return this.containerFetch(forwardedRequest, port);
    }

    if (url.pathname === '/agent-ws') {
      // WebSocket, donc fetch() (pas containerFetch()) ; AGENT_PORT est deja
      // defaultPort donc pas besoin de switchPort ici. super.fetch(), pas
      // this.fetch(), pour eviter la recursion infinie sur notre override.
      return super.fetch(request);
    }

    return new Response('Route de conteneur inconnue', { status: 404 });
  }
}

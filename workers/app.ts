/**
 * Point d'entrée du Cloudflare Worker pur (remplace functions/[[path]].ts).
 *
 * Avant : Cloudflare Pages détectait automatiquement functions/[[path]].ts
 * et gérait le routing + le service des assets statiques à notre place.
 *
 * Maintenant : c'est ce fichier qui reçoit TOUTES les requêtes qui ne
 * correspondent à aucun asset statique du dossier build/client (le
 * matching + service des fichiers statiques est géré nativement par
 * Cloudflare via le binding [assets] défini dans wrangler.toml : si un
 * fichier correspond, il est servi directement sans exécuter ce Worker).
 */
import { createRequestHandler, type ServerBuild } from '@remix-run/cloudflare';
import { getContainer } from '@cloudflare/containers';
import { getLoadContext } from '../load-context';
import { routeToContainer } from './container-router';

// Réexporté pour que `wrangler.toml` (bloc [[containers]] / [[durable_objects.bindings]])
// puisse référencer cette classe une fois décommenté.
export { UserContainer } from '../container/user-container';

// Généré par `pnpm run build` (remix vite:build) -> build/server/index.js
// N'existe qu'après le build, d'où l'erreur TS attendue en local avant un premier build.
// @ts-expect-error - le bundle serveur n'existe qu'après `pnpm run build`
import * as remixServerBuild from '../build/server';

const build = remixServerBuild as unknown as ServerBuild;

const requestHandler = createRequestHandler(build, 'production');

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Trafic vers le conteneur distant (fs/exec/watch + preview) :
      // /api/container/<sessionId>/... — voir container-router.ts
      if (url.pathname.startsWith('/api/container/')) {
        return routeToContainer(request, env, getContainer);
      }

      const loadContext = getLoadContext({ request, env, ctx });

      return await requestHandler(request, loadContext);
    } catch (error) {
      console.error('[worker] erreur non gérée :', error);
      return new Response('Erreur interne du serveur', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

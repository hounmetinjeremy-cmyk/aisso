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
 *
 * Conteneurs (payants) totalement retirés le 18/08 : plus de routing vers
 * un service de conteneur ici.
 */
import { createRequestHandler, type ServerBuild } from '@remix-run/cloudflare';
import { getLoadContext } from '../load-context';

// Généré par `pnpm run build` (remix vite:build) -> build/server/index.js
// N'existe qu'après le build, d'où l'erreur TS attendue en local avant un premier build.
// @ts-expect-error - le bundle serveur n'existe qu'après `pnpm run build`
import * as remixServerBuild from '../build/server';

const build = remixServerBuild as unknown as ServerBuild;

const requestHandler = createRequestHandler(build, 'production');

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const loadContext = getLoadContext({ request, env, ctx });
      const response = await requestHandler(request, loadContext);

      /*
       * Les fichiers statiques hachés (JS/CSS dans build/client) sont servis directement par le
       * binding [assets] de Cloudflare, jamais par ce Worker — leur cache long-terme n'est pas
       * concerné ici. Mais les pages HTML rendues par Remix (ce fetch) n'avaient aucun en-tête de
       * cache explicite : testé en réel, un correctif tout juste déployé continuait à s'afficher
       * avec l'ancien code, obligeant à un rechargement forcé à chaque fois. On force ces réponses
       * HTML à ne jamais être mises en cache (navigateur ou intermédiaire), pour que chaque
       * déploiement soit visible immédiatement à la prochaine requête.
       */
      if (response.headers.get('Content-Type')?.includes('text/html')) {
        const freshHeaders = new Headers(response.headers);
        freshHeaders.set('Cache-Control', 'no-store, must-revalidate');

        return new Response(response.body, { status: response.status, headers: freshHeaders });
      }

      return response;
    } catch (error) {
      console.error('[worker] erreur non gérée :', error);
      return new Response('Erreur interne du serveur', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

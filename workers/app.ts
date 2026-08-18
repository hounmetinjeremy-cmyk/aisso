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

      return await requestHandler(request, loadContext);
    } catch (error) {
      console.error('[worker] erreur non gérée :', error);
      return new Response('Erreur interne du serveur', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

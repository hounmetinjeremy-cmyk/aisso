import { type AppLoadContext } from '@remix-run/cloudflare';
import { type PlatformProxy } from 'wrangler';

type Cloudflare = Omit<PlatformProxy<Env>, 'dispose'>;

declare module '@remix-run/cloudflare' {
  interface AppLoadContext {
    cloudflare: Cloudflare;
  }
}

/**
 * Construit le load context Remix pour la PRODUCTION (Worker pur, workers/app.ts).
 *
 * Note dev : en local (`pnpm run dev` via remix vite:dev), ce contexte est
 * fourni automatiquement par le plugin `cloudflareDevProxyVitePlugin` déclaré
 * dans vite.config.ts, qui lit directement wrangler.toml. Cette fonction
 * n'est donc appelée qu'en environnement déployé (wrangler dev / prod).
 */
export function getLoadContext({
  request,
  env,
  ctx,
}: {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
}): AppLoadContext {
  return {
    cloudflare: {
      env,
      ctx: {
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException.bind(ctx),
        props: {},
      },
      cf: request.cf as Cloudflare['cf'],
      caches: caches as unknown as Cloudflare['caches'],
    } satisfies Cloudflare,
  };
}

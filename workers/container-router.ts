/**
 * Route /api/container/<sessionId>/<...reste> vers l'instance UserContainer
 * (Durable Object) correspondant à cette session, en ne transmettant que
 * <...reste> (UserContainer.fetch ne connaît que /agent-ws et /preview/<port>/*).
 *
 * `getContainer` est injecté en paramètre (plutôt qu'importé ici) uniquement
 * pour ne pas alourdir ce petit module de tests unitaires éventuels.
 */
export async function routeToContainer(
  request: Request,
  env: Env,
  getContainer: (binding: DurableObjectNamespace, name: string) => { fetch(request: Request): Promise<Response> },
): Promise<Response> {
  // @ts-expect-error - USER_CONTAINER n'existe dans Env qu'une fois le bloc
  // [[containers]] / [[durable_objects.bindings]] décommenté dans wrangler.toml
  // (voir container/README.md pour l'activer).
  const binding = env.USER_CONTAINER as DurableObjectNamespace | undefined;

  if (!binding) {
    return new Response(
      'Le conteneur distant n\'est pas encore activé côté serveur. ' +
        'Voir container/README.md pour construire l\'image et décommenter ' +
        'le binding USER_CONTAINER dans wrangler.toml.',
      { status: 501 },
    );
  }

  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'container', sessionId, ...rest]
  const sessionId = segments[2];

  if (!sessionId) {
    return new Response('sessionId manquant dans l\'URL', { status: 400 });
  }

  const forwardedUrl = new URL(request.url);
  forwardedUrl.pathname = '/' + segments.slice(3).join('/');

  const forwardedRequest = new Request(forwardedUrl, request);
  const instance = getContainer(binding, sessionId);

  return instance.fetch(forwardedRequest);
}

# aisso-exec-service

Terminal réel pour Aïsso, hébergé séparément (le Worker Cloudflare d'Aïsso ne peut exécuter aucune commande shell lui-même — voir `app/lib/webcontainer/index.ts` dans le dépôt principal). Un seul point d'entrée : `POST /run`, protégé par un jeton secret.

## Déploiement sur Render.com (gratuit, aucune carte bancaire)

1. Sur [render.com](https://render.com), **New +** → **Web Service**.
2. Connecte ce dépôt GitHub, choisis **Root Directory: `exec-service`** (ce sous-dossier).
3. Render détecte le `Dockerfile` automatiquement (Runtime: Docker).
4. Plan : **Free**.
5. Onglet **Environment** → ajoute la variable :
   - `EXEC_SERVICE_TOKEN` = un jeton aléatoire long, généré une seule fois avec :
     ```
     openssl rand -hex 32
     ```
     (ou `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` si openssl n'est pas disponible)
6. **Create Web Service**. Render construit l'image et te donne une URL du type `https://aisso-exec-xxxx.onrender.com`.

## Côté Aïsso (dépôt principal)

Configure les mêmes informations comme secrets Cloudflare (jamais dans un fichier committé) :

```
npx wrangler secret put EXEC_SERVICE_URL
# colle : https://aisso-exec-xxxx.onrender.com

npx wrangler secret put EXEC_SERVICE_TOKEN
# colle EXACTEMENT le même jeton que sur Render à l'étape 5
```

## Sécurité — à lire avant de déployer

- `EXEC_SERVICE_TOKEN` est la **seule** protection de cette route : quiconque le connaît peut exécuter n'importe quelle commande sur ce conteneur. Ne jamais le committer, ne jamais le logger, ne jamais l'exposer au navigateur.
- Le service refuse de démarrer si `EXEC_SERVICE_TOKEN` n'est pas défini (voir `server.js`) — jamais de mode "sans protection" par accident.
- Le tier gratuit Render s'endort après 15 minutes d'inactivité (30-60s pour se réveiller à la requête suivante) — normal, pas une panne.
- Le disque n'est PAS persistant entre redémarrages du conteneur (endormissement inclus) : tout ce qui est écrit dans `/workspace` disparaît si le service redémarre. Pour un projet donné, l'IA doit re-cloner/réimporter si besoin après un réveil à froid.

## Test manuel

```bash
curl -X POST https://aisso-exec-xxxx.onrender.com/run \
  -H "Authorization: Bearer <TON_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo hello && node --version"}'
```

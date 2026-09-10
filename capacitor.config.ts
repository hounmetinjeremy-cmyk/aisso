import type { CapacitorConfig } from '@capacitor/cli';

/*
 * Aisso reste une app web servie par le Worker Cloudflare (chat streaming,
 * API cote serveur, GraphQL/GitHub/Supabase) — pas question de l'embarquer en
 * fichiers statiques locaux dans l'APK. `server.url` fait charger cette URL
 * directement dans la WebView native : meme code, meme deploiement continu
 * que la version web, juste enveloppe dans une appli installable.
 *
 * Remplace SERVER_URL si le sous-domaine workers.dev reel differe (visible
 * dans la barre d'adresse du navigateur sur le site deploye).
 */
const SERVER_URL = 'https://aisso.hounmetinjeremy.workers.dev';

const config: CapacitorConfig = {
  appId: 'dev.aisso.app',
  appName: 'Aïsso',
  webDir: 'build/client',
  server: {
    url: SERVER_URL,
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    /*
     * Connexion Google native (Credential Manager Android) au lieu du
     * flux web (popup/redirection) — Google bloque volontairement ce
     * dernier dans une WebView embarquee, ce qui faisait rebondir vers
     * Chrome sans jamais revenir dans l'app (voir AuthGate.client.tsx).
     * skipNativeAuth: false laisse le plugin gerer FirebaseAuth
     * nativement ; AuthGate.client.tsx resynchronise ensuite le SDK web
     * (deja utilise partout ailleurs dans l'app) via signInWithCredential.
     */
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['google.com'],
    },
  },
};

export default config;

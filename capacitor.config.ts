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
};

export default config;

import { useStore } from '@nanostores/react';
import type { LinksFunction } from '@remix-run/cloudflare';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useNavigate } from '@remix-run/react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import { themeStore } from './lib/stores/theme';
import { stripIndents } from './utils/stripIndent';
import { createHead } from 'remix-island';
import { useEffect } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ClientOnly } from 'remix-utils/client-only';
import { AuthGate } from './components/auth/AuthGate.client';
import { cssTransition, ToastContainer } from 'react-toastify';

import reactToastifyStyles from 'react-toastify/dist/ReactToastify.css?url';
import globalStyles from './styles/index.scss?url';

import 'virtual:uno.css';

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: '/favicon.svg',
    type: 'image/svg+xml',
  },
  { rel: 'stylesheet', href: reactToastifyStyles },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

const inlineThemeCode = stripIndents`
  setTutorialKitTheme();

  function setTutorialKitTheme() {
    let theme = localStorage.getItem('bolt_theme');

    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.querySelector('html')?.setAttribute('data-theme', theme);
  }
`;

export const Head = createHead(() => (
  <>
    <meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <Meta />
    <Links />
    <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
  </>
));

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useStore(themeStore);

  useEffect(() => {
    document.querySelector('html')?.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <>
      <ClientOnly>{() => <DndProvider backend={HTML5Backend}>{children}</DndProvider>}</ClientOnly>
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
        autoClose={3000}
      />
      <ScrollRestoration />
      <Scripts />
    </>
  );
}

import { logStore } from './lib/stores/logs';

export default function App() {
  const theme = useStore(themeStore);
  const navigate = useNavigate();

  /*
   * Retour de l'OAuth MCP (ex: connecteur GitHub) ouvert dans le navigateur
   * système sur l'app native — voir mcpOAuth.ts. Le fournisseur redirige
   * vers https://aisso.hounmetinjeremy.workers.dev/mcp-oauth/callback?...,
   * Android intercepte via l'App Link déclaré dans AndroidManifest.xml et
   * relance l'app au lieu de laisser l'utilisateur dans le navigateur — sans
   * ce listener, l'app reviendrait au premier plan sans jamais router vers
   * /mcp-oauth/callback, donc sans jamais échanger le code contre un token.
   */
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return undefined;
    }

    const listenerPromise = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      Browser.close().catch(() => {});

      try {
        const parsed = new URL(url);
        navigate(`${parsed.pathname}${parsed.search}`);
      } catch (error) {
        console.error('[app-link] failed to parse incoming URL', url, error);
      }
    });

    return () => {
      listenerPromise.then((listener) => listener.remove()).catch(() => {});
    };
  }, [navigate]);

  useEffect(() => {
    logStore.logSystem('Application initialized', {
      theme,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Initialize debug logging with improved error handling
    import('./utils/debugLogger')
      .then(({ debugLogger }) => {
        /*
         * The debug logger initializes itself and starts disabled by default
         * It will only start capturing when enableDebugMode() is called
         */
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });
  }, []);

  return (
    <Layout>
      <ClientOnly
        fallback={
          <div className="flex items-center justify-center h-full w-full bg-bolt-elements-background-depth-1">
            <div className="i-svg-spinners:90-ring-with-bg text-2xl text-bolt-elements-textPrimary" />
          </div>
        }
      >
        {() => (
          <AuthGate>
            <Outlet />
          </AuthGate>
        )}
      </ClientOnly>
    </Layout>
  );
}

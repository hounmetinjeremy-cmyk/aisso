import { RemixBrowser } from '@remix-run/react';
import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { logStore } from '~/lib/stores/logs';

/*
 * Toujours actif (contrairement à debugLogger.ts, un système de capture bien
 * plus lourd mais désactivé par défaut) — une erreur dans un gestionnaire de
 * clic ou une promesse non gérée ne remonte jamais jusqu'à un ErrorBoundary
 * React (qui ne capture que les erreurs de rendu). Sans ça, ce genre d'échec
 * est totalement invisible pour l'utilisateur : un clic qui ne fait plus rien,
 * sans aucune trace consultable (voir Paramètres > Journaux d'événements).
 */
window.addEventListener('error', (event) => {
  logStore.logError('Unhandled error', event.error ?? event.message, {
    component: 'window.onerror',
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  logStore.logError('Unhandled promise rejection', event.reason, {
    component: 'window.onunhandledrejection',
  });
});

startTransition(() => {
  hydrateRoot(document.getElementById('root')!, <RemixBrowser />);
});

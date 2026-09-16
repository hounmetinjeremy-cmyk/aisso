import React, { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { logStore } from '~/lib/stores/logs';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Filet de sécurité au niveau de l'app entière (chat + éditeur). Sans ça, une
 * erreur de rendu dans n'importe quel composant enfant (un fichier importé au
 * contenu inattendu, un état incohérent après un import massif, etc.) démonte
 * silencieusement tout l'arbre React — l'utilisateur se retrouve avec une
 * interface figée où plus rien ne réagit aux clics, sans le moindre message.
 */
export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('AppErrorBoundary caught an error:', error, errorInfo);
    logStore.logError('Unhandled render error', error, {
      component: 'AppErrorBoundary',
      componentStack: errorInfo.componentStack,
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full w-full p-8 text-center space-y-4 bg-bolt-elements-background-depth-1">
          <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
            <div className="i-ph:warning-duotone text-2xl text-red-500" />
          </div>

          <div>
            <h3 className="text-lg font-medium text-bolt-elements-textPrimary mb-2">Une erreur est survenue</h3>
            <p className="text-sm text-bolt-elements-textSecondary mb-4 max-w-md">
              L'interface a rencontré un problème inattendu et s'est figée. Vos fichiers et votre conversation ne sont
              pas perdus — réessayez, ou rechargez la page si ça ne suffit pas.
            </p>

            {this.state.error && (
              <details className="text-xs text-bolt-elements-textTertiary mb-4">
                <summary className="cursor-pointer hover:text-bolt-elements-textSecondary">
                  Voir le détail de l'erreur
                </summary>
                <pre className="mt-2 p-2 bg-bolt-elements-background-depth-2 rounded text-left overflow-auto whitespace-pre-wrap">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-lg text-sm bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-backgroundActive"
            >
              Réessayer
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm bg-bolt-elements-button-secondary-background text-bolt-elements-button-secondary-text hover:bg-bolt-elements-button-secondary-backgroundHover"
            >
              Recharger la page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

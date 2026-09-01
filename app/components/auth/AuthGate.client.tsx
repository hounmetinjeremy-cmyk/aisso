import { useEffect, useState, type ReactNode } from 'react';
import { GoogleAuthProvider, getRedirectResult, signInWithPopup } from 'firebase/auth';

import { auth } from '~/lib/firebase.client';
import { useAuth } from '~/lib/hooks/useAuth.client';

const googleProvider = new GoogleAuthProvider();

// Force l'écran de sélection de compte : l'utilisateur choisit son Gmail à chaque connexion.
googleProvider.setCustomParameters({ prompt: 'select_account' });

function readableError(code: string, fallback: string) {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Connexion Google annulée.';
    case 'auth/popup-blocked':
      return 'La fenêtre Google a été bloquée par le navigateur.';
    case 'auth/account-exists-with-different-credential':
      return 'Un compte existe déjà avec cet e-mail via une autre méthode.';
    case 'auth/unauthorized-domain':
      return "Ce domaine n'est pas autorisé dans la console Firebase.";
    case 'auth/network-request-failed':
      return 'Connexion impossible. Vérifie ton réseau.';
    default:
      return fallback;
  }
}

function messageFrom(error: unknown) {
  const err = error as { code?: string; message?: string };
  return readableError(err?.code ?? '', err?.message ?? 'Une erreur est survenue.');
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.7l7.8 6.1C12.3 13.6 17.6 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.9 7.2l7.6 5.9c4.4-4.1 7.1-10.2 7.1-17.6z"
      />
      <path fill="#FBBC05" d="M10.4 28.4a14.5 14.5 0 0 1 0-8.6l-7.8-6.1a23.5 23.5 0 0 0 0 20.8l7.8-6.1z" />
      <path
        fill="#34A853"
        d="M24 47.5c6.2 0 11.5-2 15.4-5.5l-7.6-5.9c-2.1 1.4-4.8 2.3-7.8 2.3-6.4 0-11.7-4.1-13.6-9.9l-7.8 6.1C6.5 42.1 14.6 47.5 24 47.5z"
      />
    </svg>
  );
}

function LoginScreen({ initialError }: { initialError?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  useEffect(() => {
    getRedirectResult(auth).catch((err) => setError(messageFrom(err)));
  }, []);

  const signInWithGoogle = async () => {
    setError(null);
    setBusy(true);

    /*
     * La redirection plein écran (signInWithRedirect) reste bloquée en silence au retour
     * sur ce domaine (aisso-d9de3.firebaseapp.com ≠ domaine réel du site *.workers.dev —
     * confirmé en test réel : plusieurs tentatives, toutes restées bloquées, jamais
     * d'erreur). Tant qu'il n'y a pas de domaine d'authentification personnalisé (comme
     * auth.formoney.site pour Center), la popup reste le seul chemin fiable, même sur
     * mobile — un échec de popup redonne juste la main pour réessayer, plutôt que de
     * retomber sur la redirection qu'on sait cassée ici.
     */
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 h-full w-full px-4 text-center bg-bolt-elements-background-depth-1">
      <img src="/logo.svg" alt="Aïsso" className="w-11 h-11 opacity-90" />
      <p className="text-lg font-medium text-bolt-elements-textPrimary">Connecte-toi pour continuer</p>
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={busy}
        className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary text-sm font-medium hover:bg-bolt-elements-item-backgroundActive transition-all disabled:opacity-70"
      >
        {busy ? (
          <div className="i-svg-spinners:90-ring-with-bg text-lg" />
        ) : (
          <GoogleIcon />
        )}
        <span>{busy ? 'Connexion...' : 'Continuer avec Google'}</span>
      </button>
      {error && (
        <p role="alert" className="text-sm text-bolt-elements-icon-error max-w-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!loading) {
      setStuck(false);
      return undefined;
    }

    /*
     * Après un retour de connexion par redirection, Firebase reste parfois bloqué en
     * silence (cookies tiers/stockage partitionné sur mobile) : ni succès ni erreur,
     * juste un chargement infini. Au bout de 8s on abandonne l'attente et on propose
     * de réessayer plutôt que de tourner en rond indéfiniment.
     */
    const timer = window.setTimeout(() => setStuck(true), 8000);

    return () => window.clearTimeout(timer);
  }, [loading]);

  if (loading && !stuck) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-bolt-elements-background-depth-1">
        <div className="i-svg-spinners:90-ring-with-bg text-2xl text-bolt-elements-textPrimary" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        initialError={stuck ? 'La connexion a pris trop de temps. Réessaie.' : null}
      />
    );
  }

  return <>{children}</>;
}

import { atom } from 'nanostores';

/*
 * Etat partage du menu lateral (historique des conversations), pour pouvoir
 * l'ouvrir/fermer depuis un vrai bouton cliquable (Header), en plus du survol
 * souris existant (qui ne fonctionne pas au toucher sur mobile).
 */
export const sidebarOpen = atom<boolean>(false);

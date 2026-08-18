import { atom, type WritableAtom } from 'nanostores';
import type { ITerminal } from '~/types/terminal';
import { coloredText } from '~/utils/terminal';

/**
 * TerminalStore : plus de conteneur distant (payant) a piloter.
 *
 * Le terminal reste affichable dans l'interface, mais n'execute plus de
 * vraie commande (aucun processus a lancer sans conteneur). On garde la
 * meme API publique (toggleTerminal, attachTerminal, etc.) pour ne rien
 * casser ailleurs ; le premier parametre du constructeur est conserve
 * (mais inutilise) pour rester compatible avec l'appel existant dans
 * workbench.ts.
 */
export class TerminalStore {
  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(_webcontainerPromise: Promise<unknown>) {
    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }

  get boltTerminal() {
    return {
      ready: async () => {},
      terminal: undefined,
      process: undefined,
      executeCommand: async () => ({ exitCode: 0, output: '' }),
    };
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }

  async attachBoltTerminal(terminal: ITerminal) {
    terminal.write(
      coloredText.yellow('Terminal indisponible : aucun conteneur distant actif pour executer des commandes.\n'),
    );
  }

  async attachTerminal(terminal: ITerminal) {
    terminal.write(
      coloredText.yellow('Terminal indisponible : aucun conteneur distant actif pour executer des commandes.\n'),
    );
  }

  onTerminalResize(_cols: number, _rows: number) {
    // Rien a redimensionner : aucun processus reel n'est attache.
  }

  async detachTerminal(_terminal: ITerminal) {
    // Rien a detacher : aucun processus reel n'est attache.
  }
}

import type { Message } from 'ai';
import { generateId } from './fileUtils';

export interface ProjectCommands {
  type: string;
  setupCommand?: string;
  startCommand?: string;
  followupMessage: string;
}

interface FileContent {
  content: string;
  path: string;
}

export async function detectProjectCommands(files: FileContent[]): Promise<ProjectCommands> {
  const hasFile = (name: string) => files.some((f) => f.path.endsWith(name));

  if (hasFile('package.json')) {
    const packageJsonFile = files.find((f) => f.path.endsWith('package.json'));

    if (!packageJsonFile) {
      return { type: '', setupCommand: '', followupMessage: '' };
    }

    try {
      const packageJson = JSON.parse(packageJsonFile.content);
      const scripts = packageJson?.scripts || {};

      // Check for preferred commands in priority order
      const preferredCommands = ['dev', 'start', 'preview'];
      const availableCommand = preferredCommands.find((cmd) => scripts[cmd]);
      const setupCommand = 'npm install';

      if (availableCommand) {
        return {
          type: 'Node.js',
          setupCommand,
          startCommand: `npm run ${availableCommand}`,
          followupMessage: `Projet Node.js détecté avec un script "${availableCommand}" dans package.json.`,
        };
      }

      return {
        type: 'Node.js',
        setupCommand,
        followupMessage: 'Projet Node.js détecté, mais aucun script dev/start/preview trouvé dans package.json.',
      };
    } catch (error) {
      console.error('Error parsing package.json:', error);
      return { type: '', setupCommand: '', followupMessage: '' };
    }
  }

  if (hasFile('index.html')) {
    return {
      type: 'Static',
      startCommand: 'npx --yes serve',
      followupMessage: '',
    };
  }

  return { type: '', setupCommand: '', followupMessage: '' };
}

/**
 * Aïsso n'exécute plus rien (pas de terminal, pas de serveur de dev) : ce
 * message reste purement informatif, jamais un `<boltAction type="shell">`
 * — sinon l'historique laisse croire au modèle qu'il a déjà utilisé un
 * terminal, et il continue d'essayer sur les tours suivants.
 */
export function createCommandsMessage(commands: ProjectCommands): Message | null {
  if (!commands.setupCommand && !commands.startCommand) {
    return null;
  }

  const steps = [commands.setupCommand, commands.startCommand].filter(Boolean).map((cmd) => `- \`${cmd}\``);

  return {
    role: 'assistant',
    content: `${commands.followupMessage ? `${commands.followupMessage}\n\n` : ''}Une fois les fichiers récupérés, lance ceci depuis ton terminal local pour démarrer le projet :\n${steps.join('\n')}`,
    id: generateId(),
    createdAt: new Date(),
  };
}

export function escapeBoltArtifactTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltArtifact[^>]*>)([\s\S]*?)(<\/boltArtifact>)/g;

  return input.replace(regex, (match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltAActionTags(input: string) {
  // Regular expression to match boltArtifact tags and their content
  const regex = /(<boltAction[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

  return input.replace(regex, (match, openTag, content, closeTag) => {
    // Escape the opening tag
    const escapedOpenTag = openTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escape the closing tag
    const escapedCloseTag = closeTag.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Return the escaped version
    return `${escapedOpenTag}${content}${escapedCloseTag}`;
  });
}

export function escapeBoltTags(input: string) {
  return escapeBoltArtifactTags(escapeBoltAActionTags(input));
}

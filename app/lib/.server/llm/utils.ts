import { type UIMessage } from 'ai';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODEL_REGEX, PROVIDER_REGEX } from '~/utils/constants';
import { IGNORE_PATTERNS, type FileMap } from './constants';
import ignore from 'ignore';

/**
 * Les messages UIMessage v5 n'ont plus de `.content` — le texte vit dans
 * `.parts` (un ou plusieurs `{type: 'text', text}`), à côté des pièces
 * jointes (`file`) et des appels d'outils. Le modèle/provider (`[Model: X]`
 * / `[Provider: Y]`) n'est écrit que dans la première part texte par
 * Chat.client.tsx — les autres parts (images, etc.) sont préservées telles
 * quelles.
 */
export function extractPropertiesFromMessage(message: Omit<UIMessage, 'id'>): {
  model: string;
  provider: string;
  parts: UIMessage['parts'];
} {
  const parts = message.parts ?? [];
  const textContent = parts.find((part) => part.type === 'text')?.text ?? '';

  const modelMatch = textContent.match(MODEL_REGEX);
  const providerMatch = textContent.match(PROVIDER_REGEX);

  const model = modelMatch ? modelMatch[1] : DEFAULT_MODEL;
  const provider = providerMatch ? providerMatch[1] : DEFAULT_PROVIDER.name;

  let strippedFirstText = false;
  const cleanedParts = parts.map((part) => {
    if (part.type === 'text' && !strippedFirstText) {
      strippedFirstText = true;
      return { ...part, text: part.text.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '') };
    }

    return part;
  });

  return { model, provider, parts: cleanedParts };
}

export function simplifyBoltActions(input: string): string {
  // Using regex to match boltAction tags that have type="file"
  const regex = /(<boltAction[^>]*type="file"[^>]*>)([\s\S]*?)(<\/boltAction>)/g;

  // Replace each matching occurrence
  return input.replace(regex, (_0, openingTag, _2, closingTag) => {
    return `${openingTag}\n          ...\n        ${closingTag}`;
  });
}

export function createFilesContext(files: FileMap, useRelativePath?: boolean) {
  const ig = ignore().add(IGNORE_PATTERNS);
  let filePaths = Object.keys(files);
  filePaths = filePaths.filter((x) => {
    const relPath = x.replace('/home/project/', '');
    return !ig.ignores(relPath);
  });

  const fileContexts = filePaths
    .filter((x) => files[x] && files[x].type == 'file')
    .map((path) => {
      const dirent = files[path];

      if (!dirent || dirent.type == 'folder') {
        return '';
      }

      /*
       * dirent.content pour un fichier binaire est du base64 brut (voir
       * FilesStore) — un fichier de quelques centaines de Ko fait exploser le
       * nombre de tokens du prompt (rien d'exploitable pour le modele en
       * plus), ce qui a deja fait planter/bloquer des generations avec des
       * depots contenant des binaires. On ne l'envoie jamais tel quel.
       */
      if (dirent.isBinary) {
        return `<boltAction type="file" filePath="${useRelativePath ? path.replace('/home/project/', '') : path}">[fichier binaire, contenu non affiche]</boltAction>`;
      }

      const codeWithLinesNumbers = dirent.content
        .split('\n')
        // .map((v, i) => `${i + 1}|${v}`)
        .join('\n');

      let filePath = path;

      if (useRelativePath) {
        filePath = path.replace('/home/project/', '');
      }

      return `<boltAction type="file" filePath="${filePath}">${codeWithLinesNumbers}</boltAction>`;
    });

  return `<boltArtifact id="code-content" title="Code Content" >\n${fileContexts.join('\n')}\n</boltArtifact>`;
}

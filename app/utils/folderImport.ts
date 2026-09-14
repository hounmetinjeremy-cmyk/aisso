import type { UIMessage } from 'ai';
import { generateId } from './fileUtils';
import { detectProjectCommands, createCommandsMessage, escapeBoltTags } from './projectCommands';

export const createChatFromFolder = async (
  files: File[],
  binaryFiles: string[],
  folderName: string,
): Promise<UIMessage[]> => {
  const fileArtifacts = await Promise.all(
    files.map(async (file) => {
      return new Promise<{ content: string; path: string }>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const content = reader.result as string;
          const relativePath = file.webkitRelativePath.split('/').slice(1).join('/');
          resolve({
            content,
            path: relativePath,
          });
        };
        reader.onerror = reject;
        reader.readAsText(file);
      });
    }),
  );

  const commands = await detectProjectCommands(fileArtifacts);
  const commandsMessage = createCommandsMessage(commands);

  const binaryFilesMessage =
    binaryFiles.length > 0
      ? `\n\nSkipped ${binaryFiles.length} binary files:\n${binaryFiles.map((f) => `- ${f}`).join('\n')}`
      : '';

  const filesMessage: UIMessage = {
    id: generateId(),
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: `I've imported the contents of the "${folderName}" folder.${binaryFilesMessage}

<boltArtifact id="imported-files" title="Imported Files" type="bundled" >
${fileArtifacts
  .map(
    (file) => `<boltAction type="file" filePath="${file.path}">
${escapeBoltTags(file.content)}
</boltAction>`,
  )
  .join('\n\n')}
</boltArtifact>`,
      },
    ],
  };

  const userMessage: UIMessage = {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: `Import the "${folderName}" folder` }],
  };

  const messages = commandsMessage ? [userMessage, filesMessage, commandsMessage] : [userMessage, filesMessage];

  return messages;
};

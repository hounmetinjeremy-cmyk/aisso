import { createScopedLogger } from '~/utils/logger';
import { StreamingMessageParser, type StreamingMessageParserOptions } from './message-parser';

const logger = createScopedLogger('EnhancedMessageParser');

/**
 * Enhanced message parser that detects code blocks and file patterns
 * even when AI models don't wrap them in proper artifact tags.
 * Fixes issue #1797 where code outputs to chat instead of files.
 */
export class EnhancedStreamingMessageParser extends StreamingMessageParser {
  private _processedCodeBlocks = new Map<string, Set<string>>();
  private _artifactCounter = 0;

  /*
   * Chat.client.tsx reparse TOUS les messages de la conversation a chaque
   * chunk recu du message en cours de streaming (voir useMessageParser.ts).
   * Sans ce cache, les regexes ci-dessous (couteuses, plusieurs avec
   * `[\s\S]*?`) tournaient a nouveau sur le texte integral de chaque
   * ancien message, a chaque chunk du nouveau message — un cout qui
   * grandit avec la conversation ET avec la longueur de la reponse en
   * cours, jusqu'a bloquer l'onglet le temps que le stream se termine.
   * Un message deja vu avec un contenu inchange n'a plus besoin d'etre
   * rescanne : on retourne directement le resultat du parseur de base.
   */
  private _lastScannedInput = new Map<string, string>();

  constructor(options: StreamingMessageParserOptions = {}) {
    super(options);
  }

  parse(messageId: string, input: string): string {
    // First try the normal parsing
    let output = super.parse(messageId, input);

    if (this._lastScannedInput.get(messageId) === input) {
      return output;
    }

    this._lastScannedInput.set(messageId, input);

    // If no artifacts were detected, check for code blocks that should be files
    if (!this._hasDetectedArtifacts(input)) {
      const enhancedInput = this._detectAndWrapCodeBlocks(messageId, input);

      if (enhancedInput !== input) {
        // Reparse ce seul message avec le contenu enrichi (ne touche pas aux autres messages)
        this.resetMessage(messageId);
        output = super.parse(messageId, enhancedInput);
      }
    }

    return output;
  }

  resetMessage(messageId: string): void {
    super.resetMessage(messageId);
    this._processedCodeBlocks.delete(messageId);
    this._lastScannedInput.delete(messageId);
  }

  private _hasDetectedArtifacts(input: string): boolean {
    return input.includes('<boltArtifact') || input.includes('</boltArtifact>');
  }

  private _detectAndWrapCodeBlocks(messageId: string, input: string): string {
    // Initialize processed blocks for this message if not exists
    if (!this._processedCodeBlocks.has(messageId)) {
      this._processedCodeBlocks.set(messageId, new Set());
    }

    const processed = this._processedCodeBlocks.get(messageId)!;

    let enhanced = input;

    // Optimized regex patterns with better performance
    const patterns = [
      // Pattern 1: File path followed by code block (most common, check first)
      {
        regex: /(?:^|\n)([\/\w\-\.]+\.\w+):?\s*\n+```(\w*)\n([\s\S]*?)```/gim,
        type: 'file_path',
      },

      // Pattern 2: Explicit file creation mentions
      {
        regex:
          /(?:create|update|modify|edit|write|add|generate|here'?s?|file:?)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+)?[`'"]*([\/\w\-\.]+\.\w+)[`'"]*:?\s*\n+```(\w*)\n([\s\S]*?)```/gi,
        type: 'explicit_create',
      },

      // Pattern 3: Code blocks with filename comments
      {
        regex: /```(\w*)\n(?:\/\/|#|<!--)\s*(?:file:?|filename:?)\s*([\/\w\-\.]+\.\w+).*?\n([\s\S]*?)```/gi,
        type: 'comment_filename',
      },

      // Pattern 4: Code block with "in <filename>" context
      {
        regex: /(?:in|for|update)\s+[`'"]*([\/\w\-\.]+\.\w+)[`'"]*:?\s*\n+```(\w*)\n([\s\S]*?)```/gi,
        type: 'in_filename',
      },

      // Pattern 5: Structured files (package.json, components)
      {
        regex:
          /```(?:json|jsx?|tsx?|html?|vue|svelte)\n(\{[\s\S]*?"(?:name|version|scripts|dependencies|devDependencies)"[\s\S]*?\}|<\w+[^>]*>[\s\S]*?<\/\w+>[\s\S]*?)```/gi,
        type: 'structured_file',
      },
    ];

    /*
     * Ces 5 patterns exigent tous une fence ``` fermante. Tant qu'un bloc de
     * code est encore en cours de streaming (fence ouvrante sans fermante),
     * aucun ne peut matcher — mais les quantificateurs paresseux (`[\s\S]*?`)
     * forcent quand meme le moteur regex a essayer depuis chaque position du
     * texte avant d'abandonner. Sur un texte qui grandit a chaque token recu,
     * ca degenere vite en travail quadratique voire pire, repete a chaque
     * chunk. On ne tente ces patterns que quand toutes les fences du texte
     * sont fermees (nombre pair de ```), ce qui borne le nombre de tentatives
     * a une par bloc de code effectivement termine plutot qu'une par token.
     */
    const fenceCount = (enhanced.match(/```/g) || []).length;
    const hasOnlyClosedFences = fenceCount > 0 && fenceCount % 2 === 0;

    // Process each pattern in order of likelihood
    for (const pattern of hasOnlyClosedFences ? patterns : []) {
      enhanced = enhanced.replace(pattern.regex, (match, ...args) => {
        // Skip if already processed
        const blockHash = this._hashBlock(match);

        if (processed.has(blockHash)) {
          return match;
        }

        let filePath: string;
        let language: string;
        let content: string;

        // Extract based on pattern type
        if (pattern.type === 'comment_filename') {
          [language, filePath, content] = args;
        } else if (pattern.type === 'structured_file') {
          content = args[0];
          language = pattern.regex.source.includes('json') ? 'json' : 'jsx';
          filePath = this._inferFileNameFromContent(content, language);
        } else {
          // file_path, explicit_create, in_filename patterns
          [filePath, language, content] = args;
        }

        // Clean up the file path
        filePath = this._normalizeFilePath(filePath);

        // Validate file path
        if (!this._isValidFilePath(filePath)) {
          return match; // Return original if invalid
        }

        // Check if there's proper context for file creation
        if (!this._hasFileContext(enhanced, match)) {
          // If no clear file context, skip unless it's an explicit file pattern
          const isExplicitFilePattern =
            pattern.type === 'explicit_create' || pattern.type === 'comment_filename' || pattern.type === 'file_path';

          if (!isExplicitFilePattern) {
            return match; // Return original if no context
          }
        }

        // Mark as processed
        processed.add(blockHash);

        // Generate artifact wrapper
        const artifactId = `artifact-${messageId}-${this._artifactCounter++}`;
        const wrapped = this._wrapInArtifact(artifactId, filePath, content);

        logger.debug(`Auto-wrapped code block as file: ${filePath}`);

        return wrapped;
      });
    }

    // Also detect standalone file operations without code blocks
    const fileOperationPattern =
      /(?:create|write|save|generate)\s+(?:a\s+)?(?:new\s+)?file\s+(?:at\s+)?[`'"]*([\/\w\-\.]+\.\w+)[`'"]*\s+with\s+(?:the\s+)?(?:following\s+)?content:?\s*\n([\s\S]+?)(?=\n\n|\n(?:create|write|save|generate|now|next|then|finally)|$)/gi;

    enhanced = enhanced.replace(fileOperationPattern, (match, filePath, content) => {
      const blockHash = this._hashBlock(match);

      if (processed.has(blockHash)) {
        return match;
      }

      filePath = this._normalizeFilePath(filePath);

      if (!this._isValidFilePath(filePath)) {
        return match;
      }

      processed.add(blockHash);

      const artifactId = `artifact-${messageId}-${this._artifactCounter++}`;

      // Clean content - remove leading/trailing whitespace but preserve indentation
      content = content.trim();

      const wrapped = this._wrapInArtifact(artifactId, filePath, content);
      logger.debug(`Auto-wrapped file operation: ${filePath}`);

      return wrapped;
    });

    return enhanced;
  }

  private _wrapInArtifact(artifactId: string, filePath: string, content: string): string {
    const title = filePath.split('/').pop() || 'File';

    return `<boltArtifact id="${artifactId}" title="${title}" type="bundled">
<boltAction type="file" filePath="${filePath}">
${content}
</boltAction>
</boltArtifact>`;
  }

  private _normalizeFilePath(filePath: string): string {
    // Remove quotes, backticks, and clean up
    filePath = filePath.replace(/[`'"]/g, '').trim();

    // Ensure forward slashes
    filePath = filePath.replace(/\\/g, '/');

    // Remove leading ./ if present
    if (filePath.startsWith('./')) {
      filePath = filePath.substring(2);
    }

    // Add leading slash if missing and not a relative path
    if (!filePath.startsWith('/') && !filePath.startsWith('.')) {
      filePath = '/' + filePath;
    }

    return filePath;
  }

  private _isValidFilePath(filePath: string): boolean {
    // Check for valid file extension
    const hasExtension = /\.\w+$/.test(filePath);

    if (!hasExtension) {
      return false;
    }

    // Check for valid characters
    const isValid = /^[\/\w\-\.]+$/.test(filePath);

    if (!isValid) {
      return false;
    }

    // Exclude certain patterns that are likely not real files
    const excludePatterns = [
      /^\/?(tmp|temp|test|example)\//i,
      /\.(tmp|temp|bak|backup|old|orig)$/i,
      /^\/?(output|result|response)\//i, // Common AI response folders
      /^code_\d+\.(sh|bash|zsh)$/i, // Auto-generated shell files (our target issue)
      /^(untitled|new|demo|sample)\d*\./i, // Generic demo names
    ];

    for (const pattern of excludePatterns) {
      if (pattern.test(filePath)) {
        return false;
      }
    }

    return true;
  }

  private _hasFileContext(input: string, codeBlockMatch: string): boolean {
    // Check if there's explicit file context around the code block
    const matchIndex = input.indexOf(codeBlockMatch);

    if (matchIndex === -1) {
      return false;
    }

    // Look for context before the code block
    const beforeContext = input.substring(Math.max(0, matchIndex - 200), matchIndex);
    const afterContext = input.substring(matchIndex + codeBlockMatch.length, matchIndex + codeBlockMatch.length + 100);

    const fileContextPatterns = [
      /\b(create|write|save|add|update|modify|edit|generate)\s+(a\s+)?(new\s+)?file/i,
      /\b(file|filename|filepath)\s*[:=]/i,
      /\b(in|to|as)\s+[`'"]?[\w\-\.\/]+\.[a-z]{2,4}[`'"]?/i,
      /\b(component|module|class|function)\s+\w+/i,
    ];

    const contextText = beforeContext + afterContext;

    return fileContextPatterns.some((pattern) => pattern.test(contextText));
  }

  private _inferFileNameFromContent(content: string, language: string): string {
    // Try to infer component name from content
    const componentMatch = content.match(
      /(?:function|class|const|export\s+default\s+function|export\s+function)\s+(\w+)/,
    );

    if (componentMatch) {
      const name = componentMatch[1];
      const ext = language === 'jsx' ? '.jsx' : language === 'tsx' ? '.tsx' : '.js';

      return `/components/${name}${ext}`;
    }

    // Check for App component
    if (content.includes('function App') || content.includes('const App')) {
      return '/App.jsx';
    }

    // Default to a generic name
    return `/component-${Date.now()}.jsx`;
  }

  private _hashBlock(content: string): string {
    // Simple hash for identifying processed blocks
    let hash = 0;

    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString(36);
  }

  reset() {
    super.reset();
    this._processedCodeBlocks.clear();
    this._artifactCounter = 0;
  }
}

/**
 * Le résultat brut d'un appel d'outil MCP n'est jamais la valeur "utile"
 * directement — le protocole l'enveloppe toujours dans
 * `{content: [{type: 'text', text: '...'}, ...], isError?}` (spec MCP
 * `CallToolResult`, voir @ai-sdk/mcp). La plupart des serveurs GitHub MCP
 * sérialisent leur réponse structurée (liste de dossier, métadonnées de
 * fichier) en JSON à l'intérieur de ce texte ; pour un fichier, le texte
 * peut aussi être le contenu déjà décodé directement. Partagé entre
 * project-indexer-mcp.server.ts (pilotage déterministe) et
 * mcp-file-capture.server.ts (capture passive des lectures faites par le
 * modèle lui-même) — même enveloppe à dépiler dans les deux cas.
 */

export function extractMcpText(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const content = (raw as Record<string, unknown>).content;

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string',
    )
    .map((part) => part.text);

  return textParts.length > 0 ? textParts.join('\n') : null;
}

export function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export interface McpExtractedFileContent {
  content: string;
  isBinary: boolean;
}

/**
 * Déplie l'enveloppe MCP d'un résultat de "lecture de fichier", puis essaie
 * la forme structurée façon API GitHub ({content, encoding}) — sinon le
 * texte est traité comme le contenu déjà décodé.
 */
export function extractMcpFileContent(raw: unknown): McpExtractedFileContent | null {
  const text = extractMcpText(raw);

  if (text === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const rawContent =
        typeof obj.content === 'string' ? obj.content : typeof obj.text === 'string' ? obj.text : undefined;

      if (rawContent) {
        if (obj.encoding === 'base64') {
          try {
            return { content: decodeBase64(rawContent), isBinary: false };
          } catch {
            return { content: rawContent, isBinary: true };
          }
        }

        return { content: rawContent, isBinary: false };
      }
    }
  } catch {
    // Pas du JSON : le texte est directement le contenu du fichier.
  }

  return { content: text, isBinary: false };
}

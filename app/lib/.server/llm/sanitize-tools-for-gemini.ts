import type { ToolSet } from 'ai';

/**
 * L'API Gemini n'accepte qu'un sous-ensemble restreint de JSON Schema pour les déclarations de
 * fonctions (proto OpenAPI-like) : pas de tuple-typing (`items` sous forme de tableau), pas de
 * `oneOf`/`anyOf`/`allOf`. Le convertisseur de @ai-sdk/google@0.0.52
 * (convert-json-schema-to-openapi-schema.ts) recopie pourtant ces constructions telles quelles —
 * `items: [...]` devient un TABLEAU de schémas au lieu d'un schéma unique — ce qui plante côté
 * Gemini avec "Proto field is not repeating, cannot start list", puisque son champ `items` attend
 * un seul message Schema, jamais une liste.
 *
 * Les outils MCP (ex. le serveur GitHub officiel) exposent leur schéma en JSON Schema standard,
 * qui utilise couramment ces constructions (types optionnels via `anyOf`, tuples via `items`
 * tableau) — d'où le plantage observé uniquement avec des outils MCP, jamais avec les schémas
 * internes de l'app.
 *
 * Cette fonction simplifie best-effort le schéma pour rester compatible Gemini : collapse chaque
 * union/tuple sur sa première branche plutôt que de la rejeter. N'est appliquée qu'aux outils
 * envoyés à un modèle Google (voir stream-text.ts) — les autres providers reçoivent le schéma
 * MCP original, sans perte de fidélité.
 */
function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const { oneOf, anyOf, allOf, items, properties, ...rest } = schema as Record<string, any>;
  const result: Record<string, any> = { ...rest };

  if (properties && typeof properties === 'object') {
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, sanitizeSchemaForGemini(value)]),
    );
  }

  if (items !== undefined) {
    // Tuple-typing (`items` tableau) n'existe pas côté Gemini : on ne garde que le premier élément.
    result.items = Array.isArray(items)
      ? sanitizeSchemaForGemini(items[0] ?? { type: 'string' })
      : sanitizeSchemaForGemini(items);
  }

  if (Array.isArray(allOf) && allOf.length > 0) {
    for (const sub of allOf) {
      const sanitizedSub = sanitizeSchemaForGemini(sub) as Record<string, any>;
      Object.assign(result, sanitizedSub, {
        properties: { ...(result.properties || {}), ...(sanitizedSub.properties || {}) },
      });
    }
  }

  const union =
    (Array.isArray(oneOf) && oneOf.length > 0 && oneOf) || (Array.isArray(anyOf) && anyOf.length > 0 && anyOf);

  if (union) {
    const first = sanitizeSchemaForGemini(union[0]) as Record<string, any>;

    // Les champs déjà présents sur ce schéma (ex. `description` du paramètre parent) gardent la priorité.
    for (const [key, value] of Object.entries(first)) {
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  if (!result.type) {
    // Gemini exige un `type` sur chaque schéma ; sans info utilisable, on retombe sur une string.
    result.type = 'string';
  }

  return result;
}

function isMcpJsonSchema(parameters: unknown): parameters is { jsonSchema: unknown; [key: string]: unknown } {
  return typeof parameters === 'object' && parameters !== null && 'jsonSchema' in parameters;
}

export function sanitizeToolsForGemini(tools: ToolSet): ToolSet {
  const sanitized: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (isMcpJsonSchema(tool.parameters)) {
      sanitized[name] = {
        ...tool,
        parameters: {
          ...tool.parameters,
          jsonSchema: sanitizeSchemaForGemini(tool.parameters.jsonSchema),
        },
      } as (typeof tools)[string];
    } else {
      sanitized[name] = tool;
    }
  }

  return sanitized;
}

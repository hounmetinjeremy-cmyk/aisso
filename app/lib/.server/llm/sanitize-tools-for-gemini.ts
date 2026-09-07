import type { ToolSet } from 'ai';

/**
 * L'API Gemini n'accepte qu'un sous-ensemble restreint et strict de JSON Schema pour les
 * déclarations de fonctions (un proto OpenAPI-like) — pas de tuple-typing (`items` tableau), pas
 * de `oneOf`/`anyOf`/`allOf`, et toute clé qu'il ne reconnaît pas à un endroit donné fait planter
 * la requête entière avec "Unknown name ... Proto field is not repeating, cannot start list".
 *
 * Testé en réel à deux reprises : une première version de ce fichier "patchait" au cas par cas
 * (tuple items → premier élément, oneOf/anyOf → première branche) mais laissait passer telles
 * quelles toutes les autres clés du schéma d'origine — la moindre construction non anticipée
 * (une autre combinaison de mots-clés JSON Schema, à une autre profondeur) faisait planter
 * exactement pareil. Cette version reconstruit le schéma entièrement à partir d'une liste blanche
 * de clés connues sûres, plutôt que de essayer de deviner chaque cas problématique un par un —
 * aucune clé inconnue ne peut donc jamais s'y glisser.
 *
 * N'est appliquée qu'aux outils envoyés à un modèle Google (voir stream-text.ts) — les autres
 * providers reçoivent le schéma MCP original, sans perte de fidélité.
 */
const GEMINI_SAFE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const MAX_DEPTH = 12;

function sanitizeSchemaForGemini(schema: unknown, depth = 0): Record<string, unknown> {
  if (depth > MAX_DEPTH || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'string' };
  }

  const raw = schema as Record<string, unknown>;

  /*
   * Union (oneOf/anyOf) : on ne garde que la première branche, fusionnée sous le schéma courant
   * (les clés déjà présentes sur `raw`, ex. `description`, gardent la priorité).
   */
  const union = (Array.isArray(raw.oneOf) && raw.oneOf) || (Array.isArray(raw.anyOf) && raw.anyOf);
  let effective: Record<string, unknown> = union && union.length > 0 ? { ...(union[0] as object), ...raw } : raw;

  // allOf : fusion superficielle de toutes les branches (propriétés incluses).
  if (Array.isArray(raw.allOf)) {
    for (const sub of raw.allOf) {
      if (sub && typeof sub === 'object') {
        const subObj = sub as Record<string, unknown>;
        effective = {
          ...effective,
          ...subObj,
          properties: { ...((effective.properties as object) || {}), ...((subObj.properties as object) || {}) },
        };
      }
    }
  }

  // `type` peut être un tableau (ex. ["string", "null"]) en JSON Schema standard.
  let type = effective.type;

  if (Array.isArray(type)) {
    type = type.find((t) => t !== 'null');
  }

  if (typeof type !== 'string' || !GEMINI_SAFE_TYPES.has(type)) {
    // Pas de type utilisable : déduit depuis la forme du schéma plutôt que de deviner au hasard.
    type =
      effective.properties && typeof effective.properties === 'object'
        ? 'object'
        : effective.items
          ? 'array'
          : 'string';
  }

  const result: Record<string, unknown> = { type };

  if (typeof effective.description === 'string') {
    result.description = effective.description;
  }

  if (Array.isArray(effective.enum)) {
    result.enum = effective.enum;
  }

  if (typeof effective.format === 'string') {
    result.format = effective.format;
  }

  if (type === 'object') {
    const properties = effective.properties;
    const safeProperties: Record<string, unknown> =
      properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.fromEntries(
            Object.entries(properties as object).map(([key, value]) => [
              key,
              sanitizeSchemaForGemini(value, depth + 1),
            ]),
          )
        : {};

    result.properties = safeProperties;

    if (Array.isArray(effective.required)) {
      const requiredNames = (effective.required as unknown[]).filter(
        (name): name is string => typeof name === 'string' && name in safeProperties,
      );

      if (requiredNames.length > 0) {
        result.required = requiredNames;
      }
    }
  }

  if (type === 'array') {
    const items = effective.items;

    // Tuple-typing (`items` tableau) n'existe pas côté Gemini : on ne garde que le premier élément.
    result.items = sanitizeSchemaForGemini(Array.isArray(items) ? items[0] : items, depth + 1);
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

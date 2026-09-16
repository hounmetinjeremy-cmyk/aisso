/**
 * Traduit un appel d'outil en une ligne courte façon Claude Code ("Recherché
 * X", "Lu Y", "Exécuté Z") pour le fil de progression (voir
 * ProgressCompilation.tsx) — remplace le générique "1 outil exécuté" qui ne
 * disait ni quel outil, ni sur quoi, contrairement à ce que l'utilisateur
 * voit ici même dans cette session.
 *
 * Best-effort pour les outils MCP tiers (nom/forme des arguments non
 * garantis, contrairement aux outils "maison" ci-dessous) — ne doit jamais
 * lever, juste retomber sur un libellé générique si rien ne correspond.
 */

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

export function describeToolCall(toolCall: { toolName: string; input: unknown }): string {
  const { toolName } = toolCall;
  const args = (typeof toolCall.input === 'object' && toolCall.input !== null ? toolCall.input : {}) as Record<
    string,
    unknown
  >;

  switch (toolName) {
    case 'run_command':
      return `Exécuté : ${truncate(pickString(args, ['command']) ?? '', 60)}`;
    case 'sync_terminal_files_to_editor':
      return `Synchronisé le terminal vers l'éditeur${args.dir ? ` (${args.dir})` : ''}`;
    case 'import_github_repo':
      return `Importé ${args.owner ?? '?'}/${args.repo ?? '?'}`;
    case 'list_my_github_repos':
      return 'Listé les dépôts GitHub';
    case 'get_latest_workflow_runs':
      return 'Consulté les résultats GitHub Actions';
    case 'get_workflow_run_failure_details':
      return "Lu le détail d'un échec CI";
    case 'analyze_github_project':
      return `Analysé ${args.owner ?? '?'}/${args.repo ?? '?'}`;
    case 'list_indexed_project_files':
      return 'Listé les fichiers indexés';
    case 'read_indexed_project_file':
      return `Lu ${pickString(args, ['path']) ?? '(fichier indexé)'}`;
    default:
      break;
  }

  const path = pickString(args, ['path', 'file_path', 'filepath', 'filePath']);
  const query = pickString(args, ['query', 'q', 'search', 'pattern']);

  if (/get[_-]?file[_-]?contents?|read[_-]?file|file[_-]?content|get[_-]?blob/i.test(toolName) && path) {
    return `Lu ${path}`;
  }

  if (/search|grep|find/i.test(toolName) && query) {
    return `Recherché "${truncate(query, 40)}"`;
  }

  if (/create[_-]?or[_-]?update[_-]?file|push[_-]?files|write[_-]?file|update[_-]?file/i.test(toolName)) {
    return path ? `Poussé ${path}` : 'Poussé des fichiers sur GitHub';
  }

  if (/^delete[_-]?/i.test(toolName) && path) {
    return `Supprimé ${path}`;
  }

  if (/^list[_-]?/i.test(toolName)) {
    return `Listé (${toolName})`;
  }

  return `Utilisé l'outil ${toolName}`;
}

/*
 * Détail complet derrière la flèche de dépli PAR ÉTAPE (voir
 * ProgressCompilation.tsx) — même principe que le popup "Bash" de Claude
 * Code (Commande / Sortie) : le libellé court ci-dessus dit CE qui s'est
 * passé, ceci montre la VRAIE commande et le VRAI résultat pour qui veut
 * vérifier.
 */

const MAX_DETAIL_CHARS = 8000;

function truncateDetail(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}\n… (tronqué)`;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface ToolCallDetail {
  command: string;
  output: string;
}

export function buildToolCallDetail(toolCall: { toolName: string; input: unknown }, result: unknown): ToolCallDetail {
  const { toolName, input } = toolCall;
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  if (toolName === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : safeStringify(input);
    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;

    const res = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
    const stdout = typeof res.stdout === 'string' ? res.stdout : '';
    const stderr = typeof res.stderr === 'string' ? res.stderr : '';
    const exitCode = res.exitCode;

    const outputParts: string[] = [];

    if (stdout.trim()) {
      outputParts.push(stdout.trim());
    }

    if (stderr.trim()) {
      outputParts.push(`--- stderr ---\n${stderr.trim()}`);
    }

    if (typeof exitCode === 'number') {
      outputParts.push(`(code de sortie : ${exitCode})`);
    }

    return {
      command: cwd ? `cd ${cwd} && ${command}` : command,
      output: truncateDetail(outputParts.join('\n\n') || '(aucune sortie)'),
    };
  }

  return {
    command: `${toolName}(${truncateDetail(safeStringify(input))})`,
    output: truncateDetail(safeStringify(result)),
  };
}

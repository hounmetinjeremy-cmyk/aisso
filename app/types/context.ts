export type ContextAnnotation =
  | {
      type: 'codeContext';
      files: string[];
    }
  | {
      type: 'chatSummary';
      summary: string;
      chatId: string;
    };

export type ProgressAnnotation = {
  type: 'progress';
  label: string;
  status: 'in-progress' | 'complete' | 'error';
  order: number;
  message: string;

  /** Détail réel par outil appelé pendant cette étape (commande/entrée + sortie/résultat) — derrière la flèche de dépli PAR ÉTAPE, voir ProgressCompilation.tsx. */
  detail?: { label: string; command: string; output: string }[];
};

export type ToolCallAnnotation = {
  type: 'toolCall';
  toolCallId: string;
  serverName: string;
  toolName: string;
  toolDescription: string;
};

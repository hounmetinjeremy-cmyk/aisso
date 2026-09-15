/**
 * Forme minimale acceptée par les call-sites internes qui déclenchaient un
 * nouveau message via l'ancien `append(message: UIMessage)` de useChat v4 —
 * conservée telle quelle (au lieu du vrai UIMessage v5, plus contraignant)
 * pour ne pas avoir à retoucher tous les composants qui la relaient
 * (BaseChat -> Messages.client -> AssistantMessage -> Markdown).
 */
export type AppendMessage = {
  id?: string;
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
};

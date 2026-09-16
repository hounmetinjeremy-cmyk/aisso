import type { DesignScheme } from '~/types/design-scheme';
import { WORK_DIR } from '~/utils/constants';
import { getSystemPrompt } from './prompts';

/**
 * Fine-tuned prompt: base system prompt + MCP-first rules.
 * (Restored after accidental empty write of the long original file.)
 */
export const getFineTunedPrompt = (
  cwd: string = WORK_DIR,
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: { anonKey?: string; supabaseUrl?: string };
  },
  designScheme?: DesignScheme,
  github?: { isConnected: boolean; username: string | null },
  mcpToolsAvailable?: boolean,
  hasExecService?: boolean,
) => {
  const base = getSystemPrompt(cwd, supabase, designScheme, github, mcpToolsAvailable, hasExecService);

  const mcpBlock = mcpToolsAvailable
    ? `
<mcp_tools_critical>
MCP TOOLS ARE AVAILABLE via function calling RIGHT NOW.
- When the user says they connected an MCP server (e.g. "Go", "Git", GitHub MCP), IMMEDIATELY call the available tools to list/search repositories or resources. Do not ask them to describe the tools.
- NEVER say you have no channel to list MCP tools or no execution environment for MCP.
- NEVER pivot to scaffolding a Vite/React app unless the user explicitly asked to create a new application.
- After tool results, answer with the real data returned by the tools.
</mcp_tools_critical>
`
    : `
<mcp_tools_critical>
No MCP tools are registered in this request.
If the user says they connected MCP, tell them to open Settings → MCP, verify the server is available (OAuth connected, not invalid_token), then retry.
</mcp_tools_critical>
`;

  return `${base}\n${mcpBlock}`;
};

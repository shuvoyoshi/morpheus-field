/**
 * Morpheus MCP server (stdio). Lets any MCP agent drive every Morpheus app.
 *
 * A thin client of the Morpheus HTTP API (OPENFIELD_URL, default
 * http://127.0.0.1:3161). The tools themselves live in ./tools.ts, which the
 * in-app agent (server/agent.ts) imports too, so an external agent and the chat
 * inside the UI never disagree. Every render is queued, tracked and saved by the
 * server.
 *
 *   npx tsx mcp/server.ts            (or: npm run mcp)
 *
 * stdout is the MCP channel. Log to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_INSTRUCTIONS, TOOLS, type ToolCtx } from './tools.ts';
import { BASE } from './client.ts';

const server = new McpServer(
  { name: 'openfield', version: '0.1.0' },
  { instructions: MCP_INSTRUCTIONS },
);

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
    (args: unknown, extra: any) => t.handler(args, extra as ToolCtx),
  );
}

await server.connect(new StdioServerTransport());
console.error(`openfield-mcp: stdio ready, API ${BASE}`);

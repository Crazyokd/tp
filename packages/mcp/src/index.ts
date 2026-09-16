import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveBaseUrl } from './config.ts';
import { createTpClient, TpApiError } from './http.ts';
import { createTools } from './tools.ts';

export function createServerTools(env: NodeJS.ProcessEnv = process.env) {
  return createTools(createTpClient({ baseUrl: resolveBaseUrl(env) }));
}

function toolErrorText(error: unknown): string {
  if (error instanceof TpApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'tp', version: '0.1.0' });
  for (const tool of createServerTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        try {
          const result = await tool.execute(args);
          return {
            content: [{ type: 'text', text: result === undefined ? '' : JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: toolErrorText(error) }],
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  await main();
}

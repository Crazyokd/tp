export const launchSpec = {
  name: 'tp',
  command: 'npm',
  args: ['run', 'mcp'],
} as const;

export function renderCursorConfig(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [launchSpec.name]: {
          command: launchSpec.command,
          args: launchSpec.args,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function renderClaudeConfig(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [launchSpec.name]: {
          command: launchSpec.command,
          args: launchSpec.args,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function renderCodexConfig(): string {
  const args = launchSpec.args.map((arg) => JSON.stringify(arg)).join(', ');
  return `[mcp_servers.${launchSpec.name}]
command = "${launchSpec.command}"
args = [${args}]
`;
}

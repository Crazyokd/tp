import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderClaudeConfig, renderCodexConfig, renderCursorConfig } from './launch-spec.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const outputs = [
  { path: join(repoRoot, '.cursor/mcp.json'), content: renderCursorConfig() },
  { path: join(repoRoot, '.mcp.json'), content: renderClaudeConfig() },
  { path: join(repoRoot, '.codex/config.toml'), content: renderCodexConfig() },
];

for (const { path, content } of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

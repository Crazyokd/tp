import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { launchSpec, renderClaudeConfig, renderCodexConfig, renderCursorConfig } from '../src/launch-spec.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const generatedPaths = {
  cursor: join(repoRoot, '.cursor/mcp.json'),
  claude: join(repoRoot, '.mcp.json'),
  codex: join(repoRoot, '.codex/config.toml'),
};

test('launchSpec defines tp via npm run mcp', () => {
  assert.deepEqual(launchSpec, {
    name: 'tp',
    command: 'npm',
    args: ['run', 'mcp'],
  });
});

test('generated client configs match renderers and omit TP_BASE_URL', () => {
  for (const path of Object.values(generatedPaths)) {
    assert.ok(existsSync(path), `missing generated file: ${path}`);
  }

  assert.equal(readFileSync(generatedPaths.cursor, 'utf8'), renderCursorConfig());
  assert.equal(readFileSync(generatedPaths.claude, 'utf8'), renderClaudeConfig());
  assert.equal(readFileSync(generatedPaths.codex, 'utf8'), renderCodexConfig());

  for (const path of Object.values(generatedPaths)) {
    const content = readFileSync(path, 'utf8');
    assert.ok(!content.includes('TP_BASE_URL'), `${path} must not include TP_BASE_URL`);
  }
});

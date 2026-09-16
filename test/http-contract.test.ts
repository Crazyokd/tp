import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { generateOpenApi, operations } from '../packages/contract/src/index.ts';

test('HTTP surface is the operation table', async () => {
  const server = await readFile('packages/server/src/server.ts', 'utf8');
  assert.match(server, /matchOperation/);
  assert.doesNotMatch(await readFile('packages/web/src/api/client.ts', 'utf8'), /export async function api</);
});

test('OpenAPI paths match the operation table', () => {
  const doc = generateOpenApi();
  assert.deepEqual(
    new Set(Object.keys(doc.paths ?? {})),
    new Set(operations.map((operation) => operation.path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}'))),
  );
});

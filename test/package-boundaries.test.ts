import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FORBIDDEN = {
  '@tp/web': ['@tp/server', '@tp/adapter-browser'],
  '@tp/server': ['@tp/web', '@tp/adapter-browser'],
  '@tp/adapter-browser': ['@tp/web', '@tp/server'],
  '@tp/contract': ['@tp/web', '@tp/server', '@tp/adapter-browser'],
} as const;

const DIRECTORIES = {
  '@tp/web': 'web',
  '@tp/server': 'server',
  '@tp/adapter-browser': 'adapters/browser',
  '@tp/contract': 'contract',
} as const;

test('adapter packages live under packages/adapters, not the workspace root', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  assert.ok(pkg.workspaces.includes('packages/adapters/*'));
  const topLevel = await readdir(join(ROOT, 'packages'), { withFileTypes: true });
  for (const entry of topLevel) {
    if (!entry.isDirectory() || entry.name === 'adapters') continue;
    assert.notEqual(
      /^adapter(-|$)/.test(entry.name),
      true,
      `${entry.name} must live under packages/adapters/, not next to contract/server/web`,
    );
  }
});

test('workspace packages only depend inward on the contract', async () => {
  for (const [name, forbidden] of Object.entries(FORBIDDEN)) {
    const dir = join(ROOT, 'packages', DIRECTORIES[name as keyof typeof DIRECTORIES]);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const spec of forbidden) {
      assert.equal(deps[spec], undefined, `${name} must not declare ${spec}`);
    }
    for (const file of await walk(join(dir, 'src'))) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const source = await readFile(file, 'utf8');
      for (const spec of forbidden) {
        assert.doesNotMatch(source, new RegExp(`from ['"]${spec}(?:/[^'"]*)?['"]`));
        assert.doesNotMatch(source, new RegExp(`import\\(['"]${spec}(?:/[^'"]*)?['"]\\)`));
      }
    }
  }
});

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

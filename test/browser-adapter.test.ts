import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAdapterRegistry } from '../packages/server/src/adapter-registry.ts';
import { loadAdapterModules } from '../packages/server/src/adapter-loader.ts';
import { createHttpServer } from '../packages/server/src/server.ts';

test('registry loads browser adapter capabilities from its package specifier', async () => {
  const registry = createAdapterRegistry();
  await loadAdapterModules(registry, ['@tp/adapter-browser']);
  const capabilities = registry.listCapabilities();
  assert.deepEqual(
    capabilities.map(({ key }) => key),
    [
      'browser.watch_requests',
      'browser.expect_requests',
      'browser.goto',
      'browser.click',
      'browser.fill',
      'browser.expect_text',
      'browser.screenshot',
      'browser.canvas_probe',
      'browser.expect',
      'browser.expect_url',
      'browser.reload',
      'browser.mouse',
      'browser.touch_drag',
      'browser.route',
      'browser.unroute',
      'browser.release',
    ],
  );
});

test('HTTP catalog exposes browser capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-browser-catalog-'));
  const server = await createHttpServer({
    dataFile: join(dir, 'db.json'),
    workspaceRoot: join(dir, 'runs'),
    adapterModules: ['@tp/adapter-browser'],
  });
  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server has no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/adapters`);
    assert.equal(response.ok, true);
    const page = (await response.json()) as { items: Array<{ capabilities: Array<{ key: string }> }> };
    const keys = new Set(page.items.flatMap((adapter) => adapter.capabilities.map(({ key }) => key)));
    assert.ok(keys.has('browser.goto'));
    assert.ok(keys.has('browser.expect_text'));
    assert.ok(keys.has('browser.expect'));
    assert.ok(keys.has('browser.route'));
    assert.ok(keys.has('browser.release'));
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

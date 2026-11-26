import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test(
  'the Vite development entry renders the TP home page without browser errors',
  { skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-web-dev-'));
    const root = fileURLToPath(new URL('../packages/web/', import.meta.url));
    const server = await createServer({
      root,
      cacheDir: join(dir, 'vite'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      assert.ok(address && typeof address === 'object');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(
          (url) => url.pathname.startsWith('/api/'),
          (route) => route.fulfill({ json: { items: [], total: 0 } }),
        );
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.getByRole('heading', { name: 'TP Test Platform' }).waitFor({ timeout: 5_000 });
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

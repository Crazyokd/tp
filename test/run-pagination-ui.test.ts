import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'vite';
import { createRunTree, type CaseDefinition } from '@tp/contract';
import { createHttpServer } from '../packages/server/src/server.ts';

const definition: CaseDefinition = {
  main: 'Main',
  trees: { Main: { type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} } },
  sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
};

test(
  'Runs pages poll only the current page, preserve failures, open old links and reset after creation',
  {
    skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed',
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-run-pages-'));
    const webRoot = fileURLToPath(new URL('../packages/web/', import.meta.url));
    const time = new Date().toISOString();
    await writeFile(
      join(dir, 'db.json'),
      JSON.stringify({
        cases: [],
        groups: [],
        batches: Array.from({ length: 23 }, (_, index) => ({
          id: `batch-${index}`,
          name: `Batch ${index}`,
          description: '',
          trigger: { kind: 'web' },
          selection: { kind: 'cases' },
          createdAt: time,
          runs: [
            {
              id: `run-${index}`,
              batchId: `batch-${index}`,
              caseId: 'deleted',
              status: 'passed',
              createdAt: time,
              startedAt: time,
              finishedAt: time,
              revision: 1,
              tree: createRunTree(definition),
              artifacts: [],
            },
          ],
        })),
      }),
    );
    await build({
      root: webRoot,
      configFile: join(webRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: join(dir, 'public') },
    });
    const server = await createHttpServer({
      dataFile: join(dir, 'db.json'),
      publicDir: join(dir, 'public'),
      adapterModules: [new URL('../packages/server/test/fixtures/test-adapter.ts', import.meta.url).href],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const queries: URLSearchParams[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/api/batches') queries.push(url.searchParams);
      });
      await page.goto(`${base}/#/runs`);
      await page.locator('[data-batch-id="batch-22"]').waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 20);
      assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.locator('[data-batch-id="batch-0"]').waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 3);
      assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
      const polls = queries.filter((query) => query.get('offset') === '20').length;
      await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/batches' && url.searchParams.get('offset') === '20';
      });
      assert.ok(queries.filter((query) => query.get('offset') === '20').length > polls);
      let failNext = true;
      await page.route('**/api/batches?*', async (route) => {
        if (failNext && new URL(route.request().url()).searchParams.get('offset') === '0') {
          failNext = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'page unavailable' }),
          });
        } else await route.continue();
      });
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await page.getByText(/page unavailable/).waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 3);
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await page.locator('[data-batch-id="batch-22"]').waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 20);
      await page.goto(`${base}/#/runs/batch-0`);
      const focused = page.locator('[data-batch-id="batch-0"]');
      await focused.waitFor();
      assert.equal(await focused.getAttribute('data-batch-focus'), 'true');
      assert.ok(
        queries.every((query) => query.get('limit') === '20' && ['0', '20'].includes(query.get('offset') ?? '')),
      );
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.locator('[data-batch-id="batch-1"]').waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 3);
      const created = await (
        await fetch(`${base}/api/cases`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New case', description: 'pagination', definition }),
        })
      ).json();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page
        .locator('article.item')
        .filter({ hasText: created.name })
        .getByRole('button', { name: '创建批次', exact: true })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: '创建批次', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      await page.getByText('New case', { exact: true }).first().waitFor();
      assert.equal(await page.locator('[data-batch-id]').count(), 20);
      assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
      await page.goto(`${base}/#/runs/missing`);
      await page.getByText(/批次.*missing.*not found/).waitFor({ timeout: 3000 });
      assert.equal(await page.locator('[data-batch-id]').count(), 20);
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      const longCase = await (
        await fetch(`${base}/api/cases`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Long running',
            description: 'off-page Worker',
            definition: {
              ...definition,
              trees: { Main: { ...definition.trees.Main, ports: { delayMs: { literal: 60_000 } } } },
            },
          }),
        })
      ).json();
      for (let index = 0; index < 21; index++) {
        const response = await fetch(`${base}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trigger: { kind: 'web' }, caseIds: [longCase.id] }),
        });
        assert.ok(response.ok);
      }
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('button', { name: 'Workers', exact: true }).click();
      await page.getByTestId('workers-page').getByText('Long running', { exact: true }).waitFor({ timeout: 3000 });
      await page.getByRole('button', { name: '查看 Run', exact: true }).click();
      await page.getByTestId('runs-page').waitFor();
      await page.locator('[data-batch-focus="true"]').waitFor();
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

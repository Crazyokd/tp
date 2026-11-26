import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'vite';
import type { CaseDefinition, TestCase } from '@tp/contract';
import { createHttpServer } from '../packages/server/src/server.ts';

const definition: CaseDefinition = {
  main: 'Main',
  trees: { Main: { type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} } },
  sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
};

test(
  'catalogs stay out of polling and refresh on page entry, edits and explicit retry',
  {
    skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed',
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-catalog-ui-'));
    const webRoot = fileURLToPath(new URL('../packages/web/', import.meta.url));
    await build({
      root: webRoot,
      configFile: join(webRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir: join(dir, 'public') },
    });
    const server = await createHttpServer({
      dataFile: join(dir, 'db.json'),
      workspaceRoot: join(dir, 'runs'),
      publicDir: join(dir, 'public'),
      adapterModules: [new URL('../packages/server/test/fixtures/test-adapter.ts', import.meta.url).href],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const write = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, `${method} ${path}: ${response.status}`);
      return response.json();
    };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const counts = { adapters: 0, cases: 0, groups: 0 };
      page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const resource = new URL(request.url()).pathname.slice('/api/'.length);
        if (resource === 'adapters' || resource === 'cases' || resource === 'groups') counts[resource]++;
      });
      const poll = () => page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workers');
      await page.goto(`${base}/#/runs`);
      await poll();
      const initial = { ...counts };
      assert.deepEqual(initial, { adapters: 1, cases: 1, groups: 1 });
      await poll();
      assert.deepEqual(counts, initial);
      const item = (await write('/api/cases', {
        name: 'External case',
        description: 'external',
        definition,
      })) as TestCase;
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page.getByText(item.name, { exact: true }).waitFor();
      assert.equal(counts.adapters, 1);
      const entered = { ...counts };
      await poll();
      assert.deepEqual(counts, entered);
      await page
        .locator('article.item')
        .filter({ hasText: item.name })
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      await page.getByTestId('case-name').fill('Edited case');
      await page.getByTestId('save-case').click();
      await page.getByText('已保存', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page.getByText('Edited case', { exact: true }).waitFor();
      assert.equal(counts.adapters, 1);
      const group = await write('/api/groups', { name: 'External group', caseIds: [item.id] });
      await page.getByRole('button', { name: 'Groups', exact: true }).click();
      await page.getByRole('heading', { name: 'External group', exact: true }).waitFor();
      await page.getByRole('button', { name: '编辑成员', exact: true }).click();
      await page.getByLabel('组名', { exact: true }).fill('Edited group');
      await page.getByRole('button', { name: '保存组', exact: true }).click();
      await page.getByRole('heading', { name: 'Edited group', exact: true }).waitFor();
      await page.getByRole('button', { name: '删除组', exact: true }).click();
      await page.getByRole('heading', { name: '暂无分组', exact: true }).waitFor();
      assert.equal(
        (await (await fetch(`${base}/api/groups`)).json()).items.some((entry: { id: string }) => entry.id === group.id),
        false,
      );
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page
        .locator('article.item')
        .filter({ hasText: 'Edited case' })
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await page.getByText('暂无 case', { exact: true }).waitFor();
      const late = await write('/api/cases', { name: 'Manual refresh case', description: 'manual', definition });
      let failNext = true;
      await page.route('**/api/cases', async (route) => {
        if (failNext && route.request().method() === 'GET') {
          failNext = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'catalog unavailable' }),
          });
        } else await route.continue();
      });
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText(/catalog unavailable/).waitFor();
      await poll();
      await page.getByText(/catalog unavailable/).waitFor();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText(late.name, { exact: true }).waitFor();
      await page.getByText(/catalog unavailable/).waitFor({ state: 'hidden' });
      assert.equal(counts.adapters, 3);
      const final = { ...counts };
      await poll();
      assert.deepEqual(counts, final);
      await page.close();
      const retry = await browser.newPage();
      let rejectInitial = true;
      await retry.route('**/api/adapters', async (route) => {
        if (rejectInitial) {
          rejectInitial = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'initial catalog unavailable' }),
          });
        } else await route.continue();
      });
      await retry.goto(`${base}/#/cases`);
      await retry.getByText(/initial catalog unavailable/).waitFor();
      await retry.getByRole('button', { name: '刷新', exact: true }).click();
      await retry.getByText(late.name, { exact: true }).waitFor();
      await retry.getByText(/initial catalog unavailable/).waitFor({ state: 'hidden' });
      await retry.close();
      const recovery = await browser.newPage();
      let adapterRequests = 0;
      await recovery.route('**/api/adapters', async (route) => {
        adapterRequests++;
        if (adapterRequests === 1) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'initial adapters unavailable' }),
          });
        } else await route.continue();
      });
      await recovery.goto(`${base}/#/groups`);
      await recovery.getByText(/initial adapters unavailable/).waitFor();
      await recovery.getByRole('button', { name: '新建组', exact: true }).click();
      await recovery.getByLabel('组名', { exact: true }).fill('Recovery group');
      await recovery.getByRole('button', { name: '保存组', exact: true }).click();
      await recovery.getByRole('heading', { name: 'Recovery group', exact: true }).waitFor();
      assert.equal(adapterRequests, 2);
      await recovery.getByText(/initial adapters unavailable/).waitFor({ state: 'hidden' });
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

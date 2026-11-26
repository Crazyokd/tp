import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'vite';
import type { Batch, CaseDefinition, TestCase, TestGroup } from '@tp/contract';
import { createHttpServer } from '../packages/server/src/server.ts';

test(
  'native Batch UI collects metadata across launchers, supports keyboard cancellation and retry, and preserves created runs',
  {
    skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed',
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-batch-ui-'));
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
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(
        `${base}${path}`,
        body === undefined
          ? {}
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      );
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json() as Promise<T>;
    };
    const definition = (delayMs: number): CaseDefinition => ({
      main: 'Main',
      trees: {
        Main: {
          type: 'Action',
          adapter: 'test',
          actor: 'robot',
          capability: 'test.pass',
          ports: { delayMs: { literal: delayMs } },
        },
      },
      sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
    });
    const first = await request<TestCase>('/api/cases', {
      name: 'Alpha',
      description: 'running member',
      definition: definition(60_000),
    });
    const second = await request<TestCase>('/api/cases', {
      name: 'Beta',
      description: 'queued member',
      definition: definition(60_000),
    });
    const fast = await request<TestCase>('/api/cases', {
      name: 'Gamma',
      description: 'fast member',
      definition: definition(0),
    });
    const group = await request<TestGroup>('/api/groups', { name: 'Smoke', caseIds: [fast.id] });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const posts: { path: string; body: unknown }[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST')
          posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
      });
      let rejectNextPoll = false;
      let rejectNextCreate = false;
      let holdNextCreate = false;
      let releaseCreate: (() => void) | undefined;
      await page.route(/\/api\/batches(?:\?.*)?$/, async (route) => {
        if (rejectNextCreate && route.request().method() === 'POST') {
          rejectNextCreate = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'creation failed; retry me' }),
          });
        }
        if (rejectNextPoll && route.request().method() === 'GET') {
          rejectNextPoll = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'invalid', message: 'temporary poll failure' }),
          });
        }
        if (holdNextCreate && route.request().method() === 'POST') {
          holdNextCreate = false;
          await new Promise<void>((resolve) => {
            releaseCreate = resolve;
          });
        }
        return route.continue();
      });
      await page.goto(base);
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page.getByRole('checkbox', { name: '选择 Alpha' }).check();
      await page.getByRole('checkbox', { name: '选择 Beta' }).check();
      const launch = page.getByRole('button', { name: '创建批次（2）', exact: true });
      await launch.click();
      const dialog = page.getByRole('dialog', { name: '创建批次', exact: true });
      await dialog.waitFor();
      assert.equal(posts.filter((post) => post.path === '/api/batches').length, 0);
      assert.equal(await page.getByLabel('批次名称').evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByLabel('批次说明').evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(
        await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('Tab');
      assert.equal(
        await dialog
          .getByRole('button', { name: '创建批次', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      // Native modal makes the background inert, including programmatic focus attempts.
      await launch.evaluate((el) => el.focus());
      assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await launch.evaluate((el) => el === document.activeElement), true);
      assert.equal(posts.filter((post) => post.path === '/api/batches').length, 0);
      await launch.click();
      await page.getByLabel('批次名称').fill('Release smoke');
      await page.getByLabel('批次说明').fill('Manual release gate');
      rejectNextCreate = true;
      await dialog.getByRole('button', { name: '创建批次', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'creation failed; retry me' }).waitFor();
      assert.equal(await page.getByLabel('批次名称').inputValue(), 'Release smoke');
      assert.equal(await page.getByLabel('批次说明').inputValue(), 'Manual release gate');
      rejectNextPoll = true;
      holdNextCreate = true;
      const createdResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/batches',
      );
      await dialog.getByRole('button', { name: '创建批次', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled,
      );
      await dialog.locator('form').evaluate((element) => {
        element.requestSubmit();
        element.requestSubmit();
      });
      assert.equal(posts.filter((post) => post.path === '/api/batches').length, 2);
      assert.ok(releaseCreate);
      releaseCreate();
      const batch = (await (await createdResponse).json()) as Batch;
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      const fold = page.locator(`[data-batch-id="${batch.id}"]`);
      await fold.waitFor({ timeout: 1000 });
      assert.equal(batch.runs.length, 2);
      await fold.getByText('Release smoke', { exact: true }).waitFor();
      await fold.getByText('Manual release gate', { exact: true }).waitFor();
      await fold.getByText('声明来源：web', { exact: true }).waitFor();
      assert.deepEqual(
        posts.filter((post) => post.path === '/api/batches'),
        Array.from({ length: 2 }, () => ({
          path: '/api/batches',
          body: {
            caseIds: [first.id, second.id],
            name: 'Release smoke',
            description: 'Manual release gate',
            trigger: { kind: 'web' },
          },
        })),
      );
      await fold.getByTestId('cancel-batch').click();
      await page.waitForFunction(
        async ({ base, id }) => {
          return (await (await fetch(`${base}/api/batches/${id}`)).json()).status === 'canceled';
        },
        { base, id: batch.id },
      );
      assert.equal(posts.filter((post) => post.path === `/api/batches/${batch.id}/cancel`).length, 1);
      assert.equal(posts.filter((post) => /^\/api\/runs\/.+\/cancel$/.test(post.path)).length, 0);

      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      const singleResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/batches',
      );
      await page
        .locator('article.item')
        .filter({ hasText: 'Gamma' })
        .getByRole('button', { name: '创建批次', exact: true })
        .click();
      await dialog.getByRole('button', { name: '创建批次', exact: true }).click();
      const single = (await (await singleResponse).json()) as Batch;
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      await page.locator(`[data-batch-id="${single.id}"]`).waitFor();
      assert.equal(single.runs.length, 1);
      assert.equal(single.name, 'Gamma');
      assert.deepEqual(posts.filter((post) => post.path === '/api/batches').at(-1)?.body, {
        caseIds: [fast.id],
        description: '',
        trigger: { kind: 'web' },
      });

      await page.getByRole('button', { name: 'Groups', exact: true }).click();
      await page.getByRole('button', { name: '运行组', exact: true }).click();
      await dialog.getByText('Group：Smoke', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(
        await page.getByRole('button', { name: '运行组', exact: true }).evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(posts.filter((post) => post.path === '/api/batches').length, 3);
      await page.getByRole('button', { name: '运行组', exact: true }).click();
      await dialog.getByRole('button', { name: '创建批次', exact: true }).click();
      await page.waitForFunction(async (base) => (await (await fetch(`${base}/api/batches`)).json()).total === 3, base);
      assert.deepEqual(posts.filter((post) => post.path === '/api/batches').at(-1)?.body, {
        groupId: group.id,
        description: '',
        trigger: { kind: 'web' },
      });
      await page.getByRole('button', { name: 'Cases', exact: true }).click();
      await page
        .locator('article.item')
        .filter({ hasText: 'Gamma' })
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      await page.getByTestId('start-run').click();
      await dialog.getByText('Cases：Gamma', { exact: true }).waitFor();
      await page.getByLabel('批次名称').fill('Builder smoke');
      await dialog.getByRole('button', { name: '创建批次', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      await page.getByText('Builder smoke', { exact: true }).waitFor();
      assert.deepEqual(posts.filter((post) => post.path === '/api/batches').at(-1)?.body, {
        caseIds: [fast.id],
        name: 'Builder smoke',
        description: '',
        trigger: { kind: 'web' },
      });
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

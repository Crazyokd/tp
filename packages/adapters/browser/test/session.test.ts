import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RuntimeLeaf } from '@tp/contract/adapter';
import { chromium } from 'playwright';

import { resetBrowserMetrics } from '../src/metrics.ts';
import { createSession } from '../src/index.ts';

const chromiumSkip = (() => {
  try {
    accessSync(chromium.executablePath());
    return false;
  } catch {
    return 'Playwright Chromium is not installed';
  }
})();

test('session drives the local demo page and writes a screenshot', { skip: chromiumSkip }, async () => {
  const metrics = resetBrowserMetrics();
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-session-'));
  const fixture = await serveFixture();
  const session = await createSession({
    runId: 'run-demo',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
  });
  try {
    const goto = await session.tick(leaf('browser.goto'), { input: { url: fixture.url } });
    assert.equal(goto.status, 'SUCCESS');
    assert.equal(typeof goto.output?.url, 'string');
    assert.match(String(goto.output?.url), /^http:\/\/127\.0\.0\.1:\d+\//);

    const fill = await session.tick(leaf('browser.fill'), { input: { selector: '#name', value: 'world' } });
    assert.deepEqual(fill, { status: 'SUCCESS', output: { filled: true } });

    const click = await session.tick(leaf('browser.click'), { input: { selector: '#go' } });
    assert.deepEqual(click, { status: 'SUCCESS', output: { clicked: true } });

    const expectText = await session.tick(leaf('browser.expect_text'), {
      input: { selector: '#out', text: 'hello world' },
    });
    assert.equal(expectText.status, 'SUCCESS');
    assert.equal(expectText.output?.text, 'hello world');

    const shot = await session.tick(leaf('browser.screenshot'), { input: { name: 'after-hello' } });
    assert.deepEqual(shot, { status: 'SUCCESS', output: { path: 'after-hello.png' } });
    const png = await readFile(join(resourceRoot, 'after-hello.png'));
    assert.ok(png.length > 0);
    const snapshot = metrics.collect();
    assert.equal(seriesValue(snapshot, 'browser_sessions_total'), 1);
    assert.equal(seriesValue(snapshot, 'browser_ticks_total', { capability: 'browser.goto', status: 'SUCCESS' }), 1);
    assert.equal(seriesValue(snapshot, 'browser_ticks_total', { capability: 'browser.click', status: 'SUCCESS' }), 1);
  } finally {
    await session.cleanup();
    assert.equal(seriesValue(metrics.collect(), 'browser_session_cleanups_total'), 1);
    await fixture.close();
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test(
  'session returns failed for illegal actor, mismatch, path escape, and post-cleanup execute',
  { skip: chromiumSkip },
  async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'tp-browser-fail-'));
    const fixture = await serveFixture();
    const session = await createSession(
      { runId: 'run-fail', actor: 'browser', resourceRoot: workspacePath, recordArtifact: () => ({ id: 'unused' }) },
      { workspacePath },
    );
    try {
      const wrongActor = await session.tick(
        { type: 'Action', adapter: 'browser', actor: 'robot', capability: 'browser.goto', path: 'browser.goto' },
        { input: { url: fixture.url } },
      );
      assert.equal(wrongActor.status, 'FAILURE');
      assert.match(String(wrongActor.output?.error), /actor must be browser/);

      await session.tick(leaf('browser.goto'), { input: { url: fixture.url } });
      const mismatch = await session.tick(leaf('browser.expect_text'), {
        input: { selector: '#out', text: 'hello world' },
      });
      assert.equal(mismatch.status, 'FAILURE');
      assert.match(String(mismatch.output?.error), /hello world/);

      const escaped = await session.tick(leaf('browser.screenshot'), { input: { name: '../escape' } });
      assert.equal(escaped.status, 'FAILURE');
      assert.match(String(escaped.output?.error), /name/);
      await assert.rejects(() => readFile(join(workspacePath, '..', 'escape.png')));
    } finally {
      await session.cleanup();
      const afterCleanup = await session.tick(leaf('browser.goto'), { input: { url: fixture.url } });
      assert.equal(afterCleanup.status, 'FAILURE');
      assert.match(String(afterCleanup.output?.error), /closed|cleanup/i);
      await fixture.close();
      await rm(workspacePath, { force: true, recursive: true });
    }
  },
);

test(
  'halt of a different tree path does not abort the running same-capability leaf',
  { skip: chromiumSkip },
  async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'tp-browser-halt-path-'));
    const hanging = await serveHanging();
    const session = await createSession(
      {
        runId: 'run-halt-path',
        actor: 'browser',
        resourceRoot: workspacePath,
        recordArtifact: () => ({ id: 'unused' }),
      },
      { workspacePath },
    );
    try {
      const running = leaf('browser.goto', 'children.0');
      const ticking = session.tick(running, { input: { url: hanging.url } });
      await hanging.accepted;
      await session.halt(leaf('browser.goto', 'children.1'));
      hanging.release();
      const result = await ticking;
      assert.equal(result.status, 'SUCCESS');
      assert.equal(typeof result.output?.url, 'string');
    } finally {
      await session.cleanup();
      await hanging.close();
      await rm(workspacePath, { force: true, recursive: true });
    }
  },
);

test('session rejects non-http goto urls', { skip: chromiumSkip }, async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'tp-browser-url-'));
  const session = await createSession(
    { runId: 'run-url', actor: 'browser', resourceRoot: workspacePath, recordArtifact: () => ({ id: 'unused' }) },
    { workspacePath },
  );
  try {
    const fileUrl = await session.tick(leaf('browser.goto'), { input: { url: 'file:///tmp/demo.html' } });
    assert.equal(fileUrl.status, 'FAILURE');
    assert.match(String(fileUrl.output?.error), /http/);
  } finally {
    await session.cleanup();
    await rm(workspacePath, { force: true, recursive: true });
  }
});

function seriesValue(
  snapshot: Array<{ name: string; series: Array<{ labels: Record<string, string>; value?: number }> }>,
  name: string,
  labels: Record<string, string> = {},
): number {
  const instrument = snapshot.find((item) => item.name === name);
  assert.ok(instrument, `missing metric ${name}`);
  const series = instrument.series.find((item) => {
    const keys = Object.keys(item.labels);
    return keys.length === Object.keys(labels).length && keys.every((key) => item.labels[key] === labels[key]);
  });
  assert.ok(series, `missing series ${name} ${JSON.stringify(labels)}`);
  return series.value ?? 0;
}

function leaf(capability: string, path = capability): RuntimeLeaf {
  return {
    type: capability === 'browser.expect_text' ? 'Condition' : 'Action',
    adapter: 'browser',
    actor: 'browser',
    capability,
    path,
  };
}

async function serveHanging(): Promise<{
  url: string;
  accepted: Promise<void>;
  release: () => void;
  close: () => Promise<void>;
}> {
  let notifyAccepted = () => undefined;
  const accepted = new Promise<void>((resolve) => {
    notifyAccepted = resolve;
  });
  let release = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((_request, response) => {
    notifyAccepted();
    void released.then(() => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body>ok</body></html>');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    accepted,
    release,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function serveFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(fileURLToPath(new URL('../fixtures/demo.html', import.meta.url)), 'utf8');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

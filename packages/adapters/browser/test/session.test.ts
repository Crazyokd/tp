import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { AdapterSessionContext, RecordArtifactInput, RuntimeLeaf } from '@tp/contract/adapter';
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

function originOf(url: string): string {
  return new URL(url).origin;
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

test('session drives the local demo page and writes a screenshot', { skip: chromiumSkip }, async () => {
  const metrics = resetBrowserMetrics();
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-session-'));
  const fixture = await serveFixture();
  const session = await createSession({
    runId: 'run-demo',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    const goto = await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
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
    assert.deepEqual(shot, { status: 'SUCCESS', output: { path: 'browser/browser/after-hello.png' } });
    const png = await readFile(join(resourceRoot, 'browser/browser/after-hello.png'));
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
      {
        runId: 'run-fail',
        actor: 'browser',
        resourceRoot: workspacePath,
        recordArtifact: () => ({ id: 'unused' }),
        input: { origin: originOf(fixture.url) },
      },
      { workspacePath },
    );
    try {
      const wrongActor = await session.tick(
        { type: 'Action', adapter: 'browser', actor: 'robot', capability: 'browser.goto', path: 'browser.goto' },
        { input: { url: pathOf(fixture.url) } },
      );
      assert.equal(wrongActor.status, 'FAILURE');
      assert.match(String(wrongActor.output?.error), /actor must be browser/);

      await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
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
      const afterCleanup = await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
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
        input: { origin: originOf(hanging.url) },
      },
      { workspacePath },
    );
    try {
      const running = leaf('browser.goto', 'children.0');
      const ticking = session.tick(running, { input: { url: pathOf(hanging.url) } });
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

test('session cleanup records an openable webm artifact', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-record-'));
  const fixture = await serveFixture();
  const { recorded, context } = recordingContext(resourceRoot, 'browser', originOf(fixture.url));
  const session = await createSession(context);
  try {
    const goto = await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
    assert.equal(goto.status, 'SUCCESS');
    assert.equal(recorded.length, 0);
  } finally {
    await session.cleanup();
    await fixture.close();
  }
  try {
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]?.input, {
      name: 'browser 录屏',
      mediaType: 'video/webm',
      path: 'browser/browser/recording.webm',
    });
    assertWebm(await readFile(join(resourceRoot, 'browser/browser/recording.webm')));
  } finally {
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('session cleanup still records after a failed leaf', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-record-fail-'));
  const fixture = await serveFixture();
  const { recorded, context } = recordingContext(resourceRoot, 'browser', originOf(fixture.url));
  const session = await createSession(context);
  try {
    await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
    const failed = await session.tick(leaf('browser.expect_text'), {
      input: { selector: '#out', text: 'missing' },
    });
    assert.equal(failed.status, 'FAILURE');
  } finally {
    await session.cleanup();
    await fixture.close();
  }
  try {
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.input.path, 'browser/browser/recording.webm');
    assertWebm(await readFile(join(resourceRoot, 'browser/browser/recording.webm')));
  } finally {
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('createSession rejects path-illegal actors before launch', async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-actor-'));
  try {
    for (const actor of ['', '  ', '../x', 'a/b', 'a\\b', 'foo..bar']) {
      let session: Awaited<ReturnType<typeof createSession>> | undefined;
      await assert.rejects(async () => {
        session = await createSession(recordingContext(resourceRoot, actor).context);
      }, /actor/);
      if (session) await session.cleanup();
    }
    await assert.rejects(() => readFile(join(resourceRoot, 'browser', '../x', 'recording.webm')));
  } finally {
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('createSession rejects a half viewport before launch', async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-viewport-'));
  try {
    await assert.rejects(
      () =>
        createSession({
          runId: 'run-viewport',
          actor: 'browser',
          resourceRoot,
          recordArtifact: () => ({ id: 'unused' }),
          input: { viewportWidth: 1440 },
        }),
      /viewportWidth and viewportHeight must be set together/,
    );
  } finally {
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test(
  'Browser rejects foreign-origin redirects and click navigation before the foreign server is contacted',
  { skip: chromiumSkip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tp-browser-origin-'));
    let foreignRequests = 0;
    const foreign = createServer((_request, response) => {
      foreignRequests += 1;
      response.end('foreign vehicle');
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignAddress = foreign.address();
    assert.ok(foreignAddress && typeof foreignAddress !== 'string');
    const foreignOrigin = `http://127.0.0.1:${foreignAddress.port}`;
    const own = createServer((request, response) => {
      if (request.url === '/redirect-chain') {
        response.writeHead(302, { location: '/redirect' });
        response.end();
        return;
      }
      if (request.url === '/same-origin') {
        response.writeHead(302, { location: '/' });
        response.end();
        return;
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: foreignOrigin });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<a id="link" href="${foreignOrigin}">Other vehicle</a><a id="mocked" href="${foreignOrigin}/mock">Mocked foreign page</a><a id="popup" href="${foreignOrigin}" target="_blank">Popup</a><form action="${foreignOrigin}" method="post"><button>Write to other vehicle</button></form>`,
      );
    });
    await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
    const address = own.address();
    assert.ok(address && typeof address !== 'string');
    try {
      for (const scenario of [
        'redirect',
        'redirect-chain',
        'link',
        'form',
        'mocked',
        'popup',
        'same-origin',
        'own-mocked',
      ]) {
        const session = await createSession({
          runId: scenario,
          actor: scenario,
          resourceRoot: root,
          recordArtifact: () => ({ id: 'video' }),
          input: { origin: `http://127.0.0.1:${address.port}` },
        });
        try {
          if (scenario === 'mocked' || scenario === 'own-mocked') {
            const routed = await session.tick(leaf('browser.route', 'mock', scenario), {
              input: {
                url: scenario === 'mocked' ? `${foreignOrigin}/mock` : '**/own-mocked',
                action: 'fulfill',
                status: 200,
                contentType: 'text/html',
                body: scenario === 'mocked' ? '<script>fetch("/write",{method:"POST"})</script>' : '<h1>own mock</h1>',
              },
            });
            assert.equal(routed.status, 'SUCCESS');
          }
          let result = await session.tick(leaf('browser.goto', 'goto', scenario), {
            input: {
              url:
                scenario.startsWith('redirect') || scenario === 'same-origin' || scenario === 'own-mocked'
                  ? `/${scenario}`
                  : '/',
            },
          });
          if (scenario === 'same-origin') {
            assert.equal(result.status, 'SUCCESS');
            assert.equal(new URL(String(result.output?.url)).pathname, '/');
            continue;
          }
          if (scenario === 'own-mocked') {
            assert.equal(result.status, 'SUCCESS');
            const text = await session.tick(leaf('browser.expect_text', 'own mock', scenario), {
              input: { selector: 'h1', text: 'own mock' },
            });
            assert.equal(text.status, 'SUCCESS');
            continue;
          }
          if (!scenario.startsWith('redirect')) {
            assert.equal(result.status, 'SUCCESS');
            result = await session.tick(leaf('browser.click', 'click', scenario), {
              input: { selector: scenario === 'form' ? 'button' : `#${scenario}` },
            });
            if (scenario === 'popup' && result.status !== 'FAILURE') {
              await delay(50);
              result = await session.tick(leaf('browser.goto', 'after-popup', scenario), { input: { url: '/' } });
            }
          }
          assert.equal(result.status, 'FAILURE', scenario);
          assert.match(String(result.output?.error), /origin/, scenario);
          assert.equal(foreignRequests, 0, scenario);
        } finally {
          await session.cleanup();
        }
      }
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => own.close(() => resolve())),
        new Promise<void>((resolve) => foreign.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('createSession rejects a missing or pathed origin before launch', async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-origin-'));
  const context = {
    runId: 'run-origin',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
  };
  try {
    await assert.rejects(() => createSession({ ...context, input: {} }), /origin/);
    await assert.rejects(() => createSession({ ...context, input: { origin: 'ftp://127.0.0.1' } }), /origin/);
    await assert.rejects(
      () => createSession({ ...context, input: { origin: 'http://user:secret@127.0.0.1:18088' } }),
      /origin/,
    );
    await assert.rejects(() => createSession({ ...context, input: { origin: 'http://127.0.0.1:18088/hmi' } }), /path/);
  } finally {
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test(
  'foreign iframe document mocks remain mocked while top-level origin protection is enabled',
  { skip: chromiumSkip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tp-browser-iframe-'));
    let foreignRequests = 0;
    const foreign = createServer((_request, response) => {
      foreignRequests += 1;
      response.end('not mocked');
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignAddress = foreign.address();
    assert.ok(foreignAddress && typeof foreignAddress !== 'string');
    const frameUrl = `http://127.0.0.1:${foreignAddress.port}/frame`;
    const own = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<script>onmessage=e=>{let d=document.createElement('div');d.id='done';d.textContent=e.data;document.body.append(d)}</script><iframe src="${frameUrl}"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
    const address = own.address();
    assert.ok(address && typeof address !== 'string');
    const session = await createSession({
      runId: 'iframe',
      actor: 'browser',
      resourceRoot: root,
      recordArtifact: () => ({ id: 'video' }),
      input: { origin: `http://127.0.0.1:${address.port}` },
    });
    try {
      assert.equal(
        (
          await session.tick(leaf('browser.route'), {
            input: {
              url: frameUrl,
              action: 'fulfill',
              status: 200,
              contentType: 'text/html',
              body: '<script>parent.postMessage("mocked iframe","*")</script>',
            },
          })
        ).status,
        'SUCCESS',
      );
      assert.equal((await session.tick(leaf('browser.goto'), { input: { url: '/' } })).status, 'SUCCESS');
      assert.equal(foreignRequests, 0);
      assert.equal(
        (await session.tick(leaf('browser.expect_text'), { input: { selector: '#done', text: 'mocked iframe' } }))
          .status,
        'SUCCESS',
      );
    } finally {
      await session.cleanup();
      await Promise.all([
        new Promise<void>((resolve) => own.close(() => resolve())),
        new Promise<void>((resolve) => foreign.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('request observations count, filter and retain real request bodies', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-requests-'));
  const fixture = await serveCatalog();
  const session = await createSession({
    runId: 'requests',
    actor: 'browser',
    resourceRoot,
    input: { origin: originOf(fixture.url) },
    recordArtifact: () => ({ id: 'unused' }),
  });
  const watched = { url: '**/api/demo/submit', method: 'POST' };
  try {
    await session.tick(leaf('browser.goto'), { input: { url: '/' } });
    assert.equal((await session.tick(leaf('browser.watch_requests'), { input: watched })).status, 'SUCCESS');
    assert.equal(
      (await session.tick(leaf('browser.expect_requests'), { input: { ...watched, count: 0 } })).status,
      'SUCCESS',
    );
    const clicked = await session.tick(leaf('browser.click'), {
      input: {
        selector: '#next',
        waitResponseUrl: '/api/demo/submit',
        waitResponseStatus: 200,
        waitResponseBody: { ok: true },
      },
    });
    assert.equal(clicked.status, 'SUCCESS');
    assert.deepEqual(clicked.output?.responseBody, { ok: true });
    const counted = await session.tick(leaf('browser.expect_requests'), {
      input: { ...watched, count: 1, expectedBody: { name: 'example-a' } },
    });
    assert.equal(counted.status, 'SUCCESS');
    assert.deepEqual(counted.output?.body, { name: 'example-a' });
    for (const previousBody of [{ name: null }, { name: 0 }, { name: 'different-string' }]) {
      assert.equal(
        (
          await session.tick(leaf('browser.expect_requests'), {
            input: { ...watched, count: 1, previousBody, changedFields: ['name'] },
          })
        ).status,
        'FAILURE',
      );
    }
    assert.equal(
      (
        await session.tick(leaf('browser.expect_requests'), {
          input: { ...watched, count: 1, expectedBody: { name: 'wrong' } },
        })
      ).status,
      'FAILURE',
    );
    assert.equal(
      (await session.tick(leaf('browser.expect_requests'), { input: { ...watched, count: 2 } })).status,
      'FAILURE',
    );
    await session.tick(leaf('browser.watch_requests'), { input: watched });
    await session.tick(leaf('browser.route'), { input: { url: watched.url, action: 'hold' } });
    await session.tick(leaf('browser.click'), { input: { selector: '#next' } });
    await session.tick(leaf('browser.click'), { input: { selector: '#next', force: true } });
    assert.equal(
      (await session.tick(leaf('browser.expect_requests'), { input: { ...watched, count: 1 } })).status,
      'SUCCESS',
    );
    assert.equal(
      (await session.tick(leaf('browser.release'), { input: { url: watched.url, action: 'continue' } })).status,
      'SUCCESS',
    );
    assert.equal(
      (await session.tick(leaf('browser.expect'), { input: { selector: 'text="started"', assertion: 'visible' } }))
        .status,
      'SUCCESS',
    );
  } finally {
    await session.cleanup();
    await fixture.close();
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test(
  'method-specific routes preserve GET polling and count only matching POST requests',
  { skip: chromiumSkip },
  async () => {
    const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-route-method-'));
    const fixture = await serveCatalog();
    const session = await createSession({
      runId: 'route-method',
      actor: 'browser',
      resourceRoot,
      input: { origin: originOf(fixture.url) },
      recordArtifact: () => ({ id: 'unused' }),
    });
    try {
      assert.equal(
        (
          await session.tick(leaf('browser.route'), {
            input: {
              url: '**/api/demo/submit',
              method: 'POST',
              action: 'fulfill',
              status: 503,
              times: 1,
              contentType: 'application/json',
              body: '{"error":"first POST"}',
            },
          })
        ).status,
        'SUCCESS',
      );
      await session.tick(leaf('browser.goto'), { input: { url: '/api/demo/submit' } });
      assert.equal(
        (await session.tick(leaf('browser.expect'), { input: { selector: '#next', assertion: 'count', count: 1 } }))
          .status,
        'SUCCESS',
      );
      const first = await session.tick(leaf('browser.click'), {
        input: { selector: '#next', waitResponseUrl: '/api/demo/submit', waitResponseStatus: 503 },
      });
      assert.equal(first.status, 'SUCCESS');
      assert.deepEqual(first.output?.responseBody, { error: 'first POST' });
      const next = await session.tick(leaf('browser.click'), {
        input: { selector: '#next', waitResponseUrl: '/api/demo/submit', waitResponseStatus: 200 },
      });
      assert.equal(next.status, 'SUCCESS');
      assert.deepEqual(next.output?.responseBody, { ok: true });
    } finally {
      await session.cleanup();
      await fixture.close();
      await rm(resourceRoot, { recursive: true, force: true });
    }
  },
);

test('touch drag sends trusted touch input and validates gesture ports', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-touch-'));
  const fixture = await serveCatalog();
  const session = await createSession({
    runId: 'run-touch',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  const input = { selector: '#pad', xRatio: 0.2, yRatio: 0.2, toXRatio: 0.8, toYRatio: 0.8, steps: 12 };
  try {
    assert.equal((await session.tick(leaf('browser.goto'), { input: { url: '/' } })).status, 'SUCCESS');
    assert.equal(
      (await session.tick(leaf('browser.mouse'), { input: { ...input, action: 'drag' } })).status,
      'SUCCESS',
    );
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#touch-state', text: 'none' } })).status,
      'SUCCESS',
    );
    for (const extra of [{ steps: 0 }, { steps: 1.5 }, { steps: undefined }, { xRatio: -0.1 }, { toXRatio: 1.1 }]) {
      assert.equal(
        (await session.tick(leaf('browser.touch_drag'), { input: { ...input, ...extra } })).status,
        'FAILURE',
      );
    }
    assert.deepEqual(await session.tick(leaf('browser.touch_drag'), { input }), {
      status: 'SUCCESS',
      output: { done: true },
    });
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#touch-state', text: 'true:120:120' } }))
        .status,
      'SUCCESS',
    );
  } finally {
    await session.cleanup();
    await fixture.close();
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test('halting a touch drag cancels input before the next tick', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-touch-halt-'));
  const fixture = await serveCatalog();
  const session = await createSession({
    runId: 'run-touch-halt',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    await session.tick(leaf('browser.goto'), { input: { url: '/' } });
    const node = leaf('browser.touch_drag');
    const ticking = session.tick(node, {
      input: { selector: '#pad', xRatio: 0.2, yRatio: 0.2, toXRatio: 0.8, toYRatio: 0.8, steps: 100 },
    });
    await fixture.firstTouchMove;
    await session.halt(node);
    assert.equal((await ticking).status, 'FAILURE');
    assert.equal(
      (
        await session.tick(leaf('browser.expect_text'), {
          input: { selector: '#touch-state', text: 'canceled' },
        })
      ).status,
      'SUCCESS',
    );
    await session.tick(leaf('browser.fill'), { input: { selector: '#name', value: 'after halt' } });
    assert.equal(
      (
        await session.tick(leaf('browser.expect_text'), {
          input: { selector: '#touch-state', text: 'canceled' },
        })
      ).status,
      'SUCCESS',
    );
  } finally {
    await session.cleanup();
    await fixture.close();
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test('halting a touch drag interrupts waiting for its target', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-touch-wait-'));
  const fixture = await serveCatalog();
  const session = await createSession({
    runId: 'run-touch-wait',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    await session.tick(leaf('browser.goto'), { input: { url: '/' } });
    const node = leaf('browser.touch_drag');
    const ticking = session.tick(node, {
      input: { selector: '#gone', xRatio: 0.2, yRatio: 0.2, toXRatio: 0.8, toYRatio: 0.8, steps: 12 },
    });
    await delay(50);
    await session.halt(node);
    const timer = new AbortController();
    try {
      const result = await Promise.race([
        ticking,
        delay(1_000, undefined, { signal: timer.signal }).then(() => {
          throw new Error('halt waited for the hidden target');
        }),
      ]);
      assert.equal(result.status, 'FAILURE');
    } finally {
      timer.abort();
    }
    assert.equal(
      (await session.tick(leaf('browser.fill'), { input: { selector: '#name', value: 'after halt' } })).status,
      'SUCCESS',
    );
  } finally {
    await session.cleanup();
    await fixture.close();
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test('session locators expect route mouse reload and session ports', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-catalog-'));
  const fixture = await serveCatalog();
  const session = await createSession({
    runId: 'run-catalog',
    actor: 'browser',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: {
      origin: originOf(fixture.url),
      viewportWidth: 1440,
      viewportHeight: 900,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      initScript: "sessionStorage.setItem('mode', 'deployer')",
    },
  });
  try {
    const goto = await session.tick(leaf('browser.goto'), { input: { url: pathOf(fixture.url) } });
    assert.equal(goto.status, 'SUCCESS');

    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: 'role=button[name="下一步"]', assertion: 'visible' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: 'text="已隐藏"', assertion: 'hidden' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#disabled', assertion: 'disabled' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#next', assertion: 'enabled' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#charge', assertion: 'unchecked' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#name', assertion: 'value', expected: 'example-a' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#busy', assertion: 'attribute', attribute: 'aria-busy', expected: 'true' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '.item', assertion: 'count', count: 2 },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#status', text: 'deployer' } })).status,
      'SUCCESS',
    );
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#lang', text: 'zh-CN' } })).status,
      'SUCCESS',
    );
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#width', text: '1440' } })).status,
      'SUCCESS',
    );
    assert.equal(
      (
        await session.tick(leaf('browser.expect_text'), {
          input: { selector: '#timezone', text: 'Asia/Shanghai' },
        })
      ).status,
      'SUCCESS',
    );
    assert.deepEqual(
      await session.tick(leaf('browser.click'), {
        input: { selector: '[aria-label="虚拟键盘"] >> role=button[name="确认"]' },
      }),
      { status: 'SUCCESS', output: { clicked: true } },
    );

    const waited = await session.tick(leaf('browser.click'), {
      input: {
        selector: 'role=button[name="下一步"]',
        waitResponseUrl: '/api/demo/submit',
        waitResponseMethod: 'POST',
        waitResponseStatus: 200,
      },
    });
    assert.equal(waited.status, 'SUCCESS');
    assert.equal(waited.output?.clicked, true);
    assert.equal(waited.output?.responseStatus, 200);
    assert.match(String(waited.output?.responseUrl), /\/api\/demo\/submit$/);
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#status', text: 'started' } })).status,
      'SUCCESS',
    );

    const routed = await session.tick(leaf('browser.route'), {
      input: { url: '**/api/demo/submit', action: 'fulfill', status: 503, body: '{}', times: 1 },
    });
    assert.deepEqual(routed, { status: 'SUCCESS', output: { routed: true } });
    const failed = await session.tick(leaf('browser.click'), {
      input: { selector: '#next', waitResponseUrl: '/api/demo/submit', waitResponseMethod: 'POST' },
    });
    assert.equal(failed.status, 'SUCCESS');
    assert.equal(failed.output?.responseStatus, 503);
    assert.equal(
      (await session.tick(leaf('browser.expect_text'), { input: { selector: '#status', text: 'failed:503' } })).status,
      'SUCCESS',
    );

    const held = await session.tick(leaf('browser.route'), {
      input: { url: '**/api/demo/submit', action: 'hold' },
    });
    assert.deepEqual(held, { status: 'SUCCESS', output: { routed: true } });
    assert.deepEqual(await session.tick(leaf('browser.click'), { input: { selector: '#next' } }), {
      status: 'SUCCESS',
      output: { clicked: true },
    });
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: '#next', assertion: 'disabled' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.release'), {
        input: {
          url: '**/api/demo/submit',
          action: 'fulfill',
          status: 200,
          body: '{}',
          expectedRequestText: '"name":"example-a"',
        },
      }),
      { status: 'SUCCESS', output: { released: true, requestBody: '{"name":"example-a"}' } },
    );
    assert.deepEqual(
      await session.tick(leaf('browser.expect'), {
        input: { selector: 'text=started', assertion: 'visible' },
      }),
      { status: 'SUCCESS', output: { matched: true } },
    );
    assert.deepEqual(await session.tick(leaf('browser.click'), { input: { selector: '#next' } }), {
      status: 'SUCCESS',
      output: { clicked: true },
    });
    const mismatchedRelease = await session.tick(leaf('browser.release'), {
      input: {
        url: '**/api/demo/submit',
        action: 'fulfill',
        status: 200,
        body: '{}',
        expectedRequestText: '"type":2',
      },
    });
    assert.equal(mismatchedRelease.status, 'FAILURE');
    assert.match(String(mismatchedRelease.output?.error), /does not include/);
    assert.deepEqual(await session.tick(leaf('browser.unroute'), { input: { url: '**/api/demo/submit' } }), {
      status: 'SUCCESS',
      output: { unrouted: true },
    });

    const dragged = await session.tick(leaf('browser.mouse'), {
      input: { action: 'drag', selector: '#pad', xRatio: 0.2, yRatio: 0.2, toXRatio: 0.8, toYRatio: 0.8, steps: 4 },
    });
    assert.deepEqual(dragged, { status: 'SUCCESS', output: { done: true } });
    const afterDrag = await session.tick(leaf('browser.expect_text'), { input: { selector: '#status', text: 'up:' } });
    assert.equal(afterDrag.status, 'SUCCESS');

    const firstProbe = await session.tick(leaf('browser.canvas_probe'), {
      input: {
        selector: '#canvas',
        minimumWidth: 200,
        minimumHeight: 120,
        minimumOccupiedPixels: 1,
        minimumCenterOccupiedPixels: 1,
      },
    });
    assert.equal(firstProbe.status, 'SUCCESS');
    assert.ok(Number(firstProbe.output?.width) >= 200);
    assert.ok(Number(firstProbe.output?.height) >= 120);
    const firstHash = firstProbe.output?.hash;
    assert.equal(typeof firstHash, 'number');
    const unchangedProbe = await session.tick(leaf('browser.canvas_probe'), {
      input: { selector: '#canvas', previousHash: firstHash },
    });
    assert.equal(unchangedProbe.status, 'FAILURE');
    assert.match(String(unchangedProbe.output?.error), /did not change/);
    assert.deepEqual(await session.tick(leaf('browser.click'), { input: { selector: '#paint' } }), {
      status: 'SUCCESS',
      output: { clicked: true },
    });
    const repaintedProbe = await session.tick(leaf('browser.canvas_probe'), {
      input: { selector: '#canvas', previousHash: firstHash, minimumOccupiedPixels: 1 },
    });
    assert.equal(repaintedProbe.status, 'SUCCESS');

    assert.deepEqual(await session.tick(leaf('browser.click'), { input: { selector: '#other' } }), {
      status: 'SUCCESS',
      output: { clicked: true },
    });
    const url = await session.tick(leaf('browser.expect_url'), { input: { regex: '/other$' } });
    assert.equal(url.status, 'SUCCESS');
    assert.match(String(url.output?.url), /\/other$/);

    const reloaded = await session.tick(leaf('browser.reload'), { input: {} });
    assert.equal(reloaded.status, 'SUCCESS');
    assert.match(String(reloaded.output?.url), /\/other$/);

    const illegal = await session.tick(leaf('browser.expect'), {
      input: { selector: '#next', assertion: 'visible', expected: 'nope' },
    });
    assert.equal(illegal.status, 'FAILURE');
    assert.match(String(illegal.output?.error), /expected is not allowed/);

    const waitWithoutUrl = await session.tick(leaf('browser.click'), {
      input: { selector: '#next', waitResponseMethod: 'POST' },
    });
    assert.equal(waitWithoutUrl.status, 'FAILURE');
    assert.match(String(waitWithoutUrl.output?.error), /waitResponseUrl/);
  } finally {
    await session.cleanup();
    await fixture.close();
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('parallel sessions do not share cookies, storage, routes, or page state', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-isolate-state-'));
  const fixture = await serveIsolation();
  const alpha = await createSession({
    runId: 'run-isolate-alpha',
    actor: 'browser-alpha',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  const beta = await createSession({
    runId: 'run-isolate-beta',
    actor: 'browser-beta',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    assert.equal(
      (
        await alpha.tick(leaf('browser.goto', 'alpha.goto', 'browser-alpha'), {
          input: { url: pathOf(`${fixture.url}?mark=alpha`) },
        })
      ).status,
      'SUCCESS',
    );
    assert.equal(
      (
        await beta.tick(leaf('browser.goto', 'beta.goto', 'browser-beta'), {
          input: { url: pathOf(`${fixture.url}?mark=beta`) },
        })
      ).status,
      'SUCCESS',
    );
    assert.deepEqual(
      await alpha.tick(leaf('browser.click', 'alpha.write', 'browser-alpha'), { input: { selector: '#write' } }),
      { status: 'SUCCESS', output: { clicked: true } },
    );
    assert.deepEqual(
      await beta.tick(leaf('browser.click', 'beta.read-before-write', 'browser-beta'), {
        input: { selector: '#read' },
      }),
      { status: 'SUCCESS', output: { clicked: true } },
    );
    assert.equal(
      (
        await beta.tick(leaf('browser.expect_text', 'beta.empty-cookie', 'browser-beta'), {
          input: { selector: '#cookie', text: 'empty' },
        })
      ).status,
      'SUCCESS',
    );
    assert.equal(
      (
        await beta.tick(leaf('browser.expect_text', 'beta.empty-local', 'browser-beta'), {
          input: { selector: '#local', text: 'empty' },
        })
      ).status,
      'SUCCESS',
    );
    assert.equal(
      (
        await beta.tick(leaf('browser.expect_text', 'beta.empty-session', 'browser-beta'), {
          input: { selector: '#session', text: 'empty' },
        })
      ).status,
      'SUCCESS',
    );

    assert.deepEqual(
      await alpha.tick(leaf('browser.click', 'alpha.read', 'browser-alpha'), { input: { selector: '#read' } }),
      { status: 'SUCCESS', output: { clicked: true } },
    );
    assert.equal(
      (
        await alpha.tick(leaf('browser.expect_text', 'alpha.cookie', 'browser-alpha'), {
          input: { selector: '#cookie', text: 'mark=alpha' },
        })
      ).status,
      'SUCCESS',
    );

    assert.deepEqual(
      await alpha.tick(leaf('browser.route', 'alpha.route', 'browser-alpha'), {
        input: { url: '**/api/mark', action: 'fulfill', status: 503, body: 'held-by-alpha' },
      }),
      { status: 'SUCCESS', output: { routed: true } },
    );
    const betaFetch = await beta.tick(leaf('browser.click', 'beta.fetch', 'browser-beta'), {
      input: { selector: '#fetch', waitResponseUrl: '/api/mark', waitResponseMethod: 'GET', waitResponseStatus: 200 },
    });
    assert.equal(betaFetch.status, 'SUCCESS');
    assert.equal(betaFetch.output?.responseStatus, 200);
    assert.equal(
      (
        await beta.tick(leaf('browser.expect_text', 'beta.api', 'browser-beta'), {
          input: { selector: '#api', text: '200:origin' },
        })
      ).status,
      'SUCCESS',
    );
    const alphaFetch = await alpha.tick(leaf('browser.click', 'alpha.fetch', 'browser-alpha'), {
      input: { selector: '#fetch', waitResponseUrl: '/api/mark', waitResponseMethod: 'GET', waitResponseStatus: 503 },
    });
    assert.equal(alphaFetch.status, 'SUCCESS');
    assert.equal(alphaFetch.output?.responseStatus, 503);
    assert.equal(
      (
        await alpha.tick(leaf('browser.expect_text', 'alpha.api', 'browser-alpha'), {
          input: { selector: '#api', text: '503:held-by-alpha' },
        })
      ).status,
      'SUCCESS',
    );
  } finally {
    await alpha.cleanup();
    await beta.cleanup();
    await fixture.close();
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('cleaning one session does not close a sibling session', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-isolate-cleanup-'));
  const fixture = await serveIsolation();
  const closing = await createSession({
    runId: 'run-close',
    actor: 'browser-close',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  const surviving = await createSession({
    runId: 'run-survive',
    actor: 'browser-survive',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    assert.equal(
      (
        await surviving.tick(leaf('browser.goto', 'survive.goto', 'browser-survive'), {
          input: { url: pathOf(fixture.url) },
        })
      ).status,
      'SUCCESS',
    );
    await closing.cleanup();
    assert.deepEqual(
      await surviving.tick(leaf('browser.click', 'survive.read', 'browser-survive'), { input: { selector: '#read' } }),
      { status: 'SUCCESS', output: { clicked: true } },
    );
    assert.equal(
      (
        await surviving.tick(leaf('browser.expect_text', 'survive.empty', 'browser-survive'), {
          input: { selector: '#local', text: 'empty' },
        })
      ).status,
      'SUCCESS',
    );
  } finally {
    await surviving.cleanup();
    await fixture.close();
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test(
  'sessions in different resource roots keep their own recordings and screenshots',
  { skip: chromiumSkip },
  async () => {
    const alphaRoot = await mkdtemp(join(tmpdir(), 'tp-browser-case-a-'));
    const betaRoot = await mkdtemp(join(tmpdir(), 'tp-browser-case-b-'));
    const fixture = await serveIsolation();
    const alphaRecorded: { input: RecordArtifactInput; id: string }[] = [];
    const betaRecorded: { input: RecordArtifactInput; id: string }[] = [];
    const alpha = await createSession({
      runId: 'case-a',
      actor: 'browser',
      resourceRoot: alphaRoot,
      recordArtifact(input) {
        const id = `a-${alphaRecorded.length + 1}`;
        alphaRecorded.push({ input, id });
        return { id };
      },
      input: { origin: originOf(fixture.url) },
    });
    const beta = await createSession({
      runId: 'case-b',
      actor: 'browser',
      resourceRoot: betaRoot,
      recordArtifact(input) {
        const id = `b-${betaRecorded.length + 1}`;
        betaRecorded.push({ input, id });
        return { id };
      },
      input: { origin: originOf(fixture.url) },
    });
    try {
      assert.equal(
        (await alpha.tick(leaf('browser.goto'), { input: { url: pathOf(`${fixture.url}?mark=case-a`) } })).status,
        'SUCCESS',
      );
      assert.equal(
        (await beta.tick(leaf('browser.goto'), { input: { url: pathOf(`${fixture.url}?mark=case-b`) } })).status,
        'SUCCESS',
      );
      assert.deepEqual(await alpha.tick(leaf('browser.screenshot'), { input: { name: 'shot' } }), {
        status: 'SUCCESS',
        output: { path: 'browser/browser/shot.png' },
      });
      assert.deepEqual(await beta.tick(leaf('browser.screenshot'), { input: { name: 'shot' } }), {
        status: 'SUCCESS',
        output: { path: 'browser/browser/shot.png' },
      });
      const alphaPng = await readFile(join(alphaRoot, 'browser/browser/shot.png'));
      const betaPng = await readFile(join(betaRoot, 'browser/browser/shot.png'));
      assert.ok(alphaPng.length > 0);
      assert.ok(betaPng.length > 0);
    } finally {
      await alpha.cleanup();
      await beta.cleanup();
      await fixture.close();
    }
    try {
      assert.equal(alphaRecorded[0]?.input.path, 'browser/browser/recording.webm');
      assert.equal(betaRecorded[0]?.input.path, 'browser/browser/recording.webm');
      assertWebm(await readFile(join(alphaRoot, 'browser/browser/recording.webm')));
      assertWebm(await readFile(join(betaRoot, 'browser/browser/recording.webm')));
    } finally {
      await rm(alphaRoot, { force: true, recursive: true });
      await rm(betaRoot, { force: true, recursive: true });
    }
  },
);

test('same-run actors do not overwrite each other screenshots', { skip: chromiumSkip }, async () => {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'tp-browser-actor-shot-'));
  const fixture = await serveIsolation();
  const left = await createSession({
    runId: 'run-actors',
    actor: 'browser-left',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  const right = await createSession({
    runId: 'run-actors',
    actor: 'browser-right',
    resourceRoot,
    recordArtifact: () => ({ id: 'unused' }),
    input: { origin: originOf(fixture.url) },
  });
  try {
    assert.equal(
      (await left.tick(leaf('browser.goto', 'left.goto', 'browser-left'), { input: { url: pathOf(fixture.url) } }))
        .status,
      'SUCCESS',
    );
    assert.equal(
      (await right.tick(leaf('browser.goto', 'right.goto', 'browser-right'), { input: { url: pathOf(fixture.url) } }))
        .status,
      'SUCCESS',
    );
    assert.deepEqual(
      await left.tick(leaf('browser.screenshot', 'left.shot', 'browser-left'), { input: { name: 'shot' } }),
      {
        status: 'SUCCESS',
        output: { path: 'browser/browser-left/shot.png' },
      },
    );
    assert.deepEqual(
      await right.tick(leaf('browser.screenshot', 'right.shot', 'browser-right'), { input: { name: 'shot' } }),
      {
        status: 'SUCCESS',
        output: { path: 'browser/browser-right/shot.png' },
      },
    );
    assert.ok((await readFile(join(resourceRoot, 'browser/browser-left/shot.png'))).length > 0);
    assert.ok((await readFile(join(resourceRoot, 'browser/browser-right/shot.png'))).length > 0);
  } finally {
    await left.cleanup();
    await right.cleanup();
    await fixture.close();
    await rm(resourceRoot, { force: true, recursive: true });
  }
});

test('session rejects non-http goto urls', { skip: chromiumSkip }, async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'tp-browser-url-'));
  const session = await createSession(
    {
      runId: 'run-url',
      actor: 'browser',
      resourceRoot: workspacePath,
      recordArtifact: () => ({ id: 'unused' }),
      input: { origin: 'http://127.0.0.1:9' },
    },
    { workspacePath },
  );
  try {
    const fileUrl = await session.tick(leaf('browser.goto'), { input: { url: 'file:///tmp/demo.html' } });
    assert.equal(fileUrl.status, 'FAILURE');
    assert.match(String(fileUrl.output?.error), /path/);
    const absolute = await session.tick(leaf('browser.goto'), { input: { url: 'https://example.com/' } });
    assert.equal(absolute.status, 'FAILURE');
    assert.match(String(absolute.output?.error), /path/);
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

function recordingContext(
  resourceRoot: string,
  actor = 'browser',
  origin = 'http://127.0.0.1:9',
): { recorded: { input: RecordArtifactInput; id: string }[]; context: AdapterSessionContext } {
  const recorded: { input: RecordArtifactInput; id: string }[] = [];
  return {
    recorded,
    context: {
      runId: 'run-record',
      actor,
      resourceRoot,
      recordArtifact(input) {
        const id = `art-${recorded.length + 1}`;
        recorded.push({ input, id });
        return { id };
      },
      input: { origin },
    },
  };
}

function assertWebm(bytes: Buffer): void {
  assert.ok(bytes.length > 4);
  assert.equal(bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), true);
}

function leaf(capability: string, path = capability, actor = 'browser'): RuntimeLeaf {
  const conditions = new Set(['browser.expect_text', 'browser.expect', 'browser.expect_url']);
  return {
    type: conditions.has(capability) ? 'Condition' : 'Action',
    adapter: 'browser',
    actor,
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

async function serveCatalog(): Promise<{ url: string; firstTouchMove: Promise<void>; close: () => Promise<void> }> {
  const html = await readFile(fileURLToPath(new URL('../fixtures/catalog.html', import.meta.url)), 'utf8');
  let onTouchMove!: () => void;
  const firstTouchMove = new Promise<void>((resolve) => {
    onTouchMove = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === '/touch-observed') {
      onTouchMove();
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/api/demo/submit') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/other') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body><p id="status">other</p></body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('catalog server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    firstTouchMove,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function serveIsolation(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(fileURLToPath(new URL('../fixtures/isolation.html', import.meta.url)), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/api/mark') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('origin');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('isolation server has no port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
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

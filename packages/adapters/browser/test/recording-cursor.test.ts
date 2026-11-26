import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { RuntimeLeaf } from '@tp/contract/adapter';

import { installRecordingCursor } from '../src/recording-cursor.ts';
import { createSession } from '../src/session.ts';

const chromiumSkip = (() => {
  try {
    accessSync(chromium.executablePath());
    return false;
  } catch {
    return 'Playwright Chromium is not installed';
  }
})();

test(
  'recording hand follows real pointer input without intercepting clicks or focus',
  { skip: chromiumSkip },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
      await context.addInitScript(installRecordingCursor);
      const page = await context.newPage();
      await page.goto(
        'data:text/html,<button id="target" style="position:absolute;left:200px;top:150px;width:120px;height:60px" onclick="this.textContent=\'clicked\'">target</button><input id="entry"><script>globalThis.pointerEvents=[];document.addEventListener("pointerdown",e=>pointerEvents.push(e.target.id))</script>',
      );
      const hand = page.locator('tp-recording-cursor');
      assert.equal(await hand.count(), 1);
      await page.mouse.move(250, 180);
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).left), '250px');
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).top), '180px');
      assert.equal(await hand.getAttribute('aria-hidden'), 'true');
      await page.mouse.down();
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).pointerEvents), 'none');
      assert.equal(await page.locator('svg').count(), 0, 'the recording decoration must not affect page selectors');
      await page.mouse.up();
      assert.equal(await page.locator('#target').innerText(), 'clicked');
      assert.deepEqual(await page.evaluate('pointerEvents'), ['target']);
      await page.locator('#entry').fill('still works');
      assert.equal(await page.locator('#entry').inputValue(), 'still works');
      assert.equal(await page.locator('button').count(), 1);
      await page.reload();
      assert.equal(await hand.count(), 1);
      await page.mouse.move(300, 210);
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).left), '300px');
    } finally {
      await browser.close();
    }
  },
);

test(
  'the hand remains decorative over native dialogs and does not dismiss a page popover',
  { skip: chromiumSkip },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript(installRecordingCursor);
      const page = await context.newPage();
      await page.goto(
        'data:text/html,<style>dialog{margin:0;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;box-sizing:border-box}</style><button id="open" onclick="modal.showModal()">Open</button><dialog id="modal"><button id="inside" onclick="this.textContent=\'clicked\'">Inside</button></dialog><button id="menu-button" popovertarget="menu">Menu</button><div popover id="menu"><button id="item" onclick="this.textContent=\'selected\'">Item</button></div>',
      );
      await page.locator('#open').click();
      const openedClip = { x: 0, y: 0, width: 120, height: 80 };
      assert.notDeepEqual(
        await page.screenshot({ clip: openedClip }),
        await page.screenshot({ clip: openedClip, style: 'tp-recording-cursor { visibility: hidden !important; }' }),
        'opening a full-screen dialog must not cover the click marker',
      );
      const box = await page.locator('#inside').boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
      assert.notDeepEqual(
        await page.screenshot({ clip }),
        await page.screenshot({ clip, style: 'tp-recording-cursor { visibility: hidden !important; }' }),
        'the hand must be painted above the modal before clicking',
      );
      await page.mouse.down();
      assert.equal(
        await page.locator('tp-recording-cursor').evaluate((element) => element.matches(':popover-open')),
        true,
      );
      await page.mouse.up();
      assert.equal(await page.locator('#inside').innerText(), 'clicked');
      await page.keyboard.press('Escape');
      await page.locator('#menu-button').click();
      await page.locator('#item').click();
      assert.equal(await page.locator('#item').innerText(), 'selected');
      assert.equal(await page.locator('#menu').evaluate((element) => element.matches(':popover-open')), true);
    } finally {
      await browser.close();
    }
  },
);

function leaf(capability: string): RuntimeLeaf {
  return {
    type: capability === 'browser.canvas_probe' ? 'Condition' : 'Action',
    adapter: 'browser',
    actor: 'browser',
    capability,
    path: capability,
  };
}

test(
  'real Browser sessions record the hand without changing canvas probe measurements',
  { skip: chromiumSkip },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'tp-cursor-probe-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/frame') {
        response.end(
          '<body style="margin:0;background:white"><div style="width:80px;height:40px;background:black"></div>',
        );
        return;
      }
      response.end(
        '<style>body{background:#d8e6f3}canvas{position:absolute;left:80px;top:60px}iframe{position:absolute;left:400px;top:60px;width:200px;height:120px;border:0}</style><canvas id="plot" width="200" height="120"></canvas><iframe id="nested" src="/frame"></iframe><script>const ctx=plot.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,200,120);ctx.fillStyle="black";ctx.fillRect(10,10,80,40)</script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const session = await createSession({
      runId: 'cursor-probe',
      actor: 'browser',
      resourceRoot: root,
      recordArtifact: () => ({ id: 'video' }),
      input: { origin: `http://127.0.0.1:${address.port}` },
    });
    try {
      assert.equal((await session.tick(leaf('browser.goto'), { input: { url: '/' } })).status, 'SUCCESS');
      await session.tick(leaf('browser.screenshot'), { input: { name: 'before' } });
      const before = await session.tick(leaf('browser.canvas_probe'), { input: { selector: '#plot' } });
      assert.equal(before.status, 'SUCCESS');
      assert.equal(
        (
          await session.tick(leaf('browser.mouse'), {
            input: { action: 'move', selector: '#plot', xRatio: 0.5, yRatio: 0.5 },
          })
        ).status,
        'SUCCESS',
      );
      const after = await session.tick(leaf('browser.canvas_probe'), { input: { selector: '#plot' } });
      assert.deepEqual(after.output, before.output, 'cursor movement must not alter the measured drawing');
      const frameBefore = await session.tick(leaf('browser.canvas_probe'), { input: { selector: '#nested' } });
      assert.equal(frameBefore.status, 'SUCCESS', String(frameBefore.output?.error));
      await session.tick(leaf('browser.mouse'), {
        input: { action: 'move', selector: '#nested', xRatio: 0.5, yRatio: 0.5 },
      });
      const frameAfter = await session.tick(leaf('browser.canvas_probe'), { input: { selector: '#nested' } });
      assert.equal(frameAfter.status, 'SUCCESS', String(frameAfter.output?.error));
      assert.deepEqual(frameAfter.output, frameBefore.output, 'measurement must exclude iframe decorations too');
      assert.equal((await session.tick(leaf('browser.click'), { input: { selector: '#plot' } })).status, 'SUCCESS');
      await session.tick(leaf('browser.screenshot'), { input: { name: 'after' } });
      assert.notDeepEqual(
        await readFile(join(root, 'browser/browser/before.png')),
        await readFile(join(root, 'browser/browser/after.png')),
      );
    } finally {
      await session.cleanup();
    }
    assert.ok((await readFile(join(root, 'browser/browser/recording.webm'))).length > 1000);
  },
);

test('page backdrop CSS cannot repaint the recording decoration background', { skip: chromiumSkip }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 500, height: 300 } });
    await context.addInitScript(installRecordingCursor);
    const page = await context.newPage();
    await page.goto(
      'data:text/html,<style>::backdrop{background:rgb(255,0,0)!important;backdrop-filter:blur(6px)!important}</style><main>Original page</main>',
    );
    assert.deepEqual(
      await page.screenshot(),
      await page.screenshot({ style: 'tp-recording-cursor::backdrop { display: none !important; }' }),
    );
  } finally {
    await browser.close();
  }
});

test(
  'iframe clicks show the hand inside the frame and hide the stale parent hand',
  { skip: chromiumSkip },
  async (t) => {
    const frameServer = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<body style="margin:0"><button style="width:100vw;height:100vh" onclick="document.body.dataset.clicked=event.isTrusted">Inside frame</button>',
      );
    });
    await new Promise<void>((resolve) => frameServer.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => frameServer.close(() => resolve())));
    const frameAddress = frameServer.address();
    assert.ok(frameAddress && typeof frameAddress !== 'string');
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<iframe style="position:absolute;left:100px;top:100px;width:300px;height:200px;border:0" src="http://127.0.0.1:${frameAddress.port}"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript(installRecordingCursor);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.mouse.move(40, 40);
      await page.locator('iframe').click();
      const frame = page.frames().find((frame) => frame.parentFrame());
      assert.ok(frame);
      assert.equal(await frame.locator('body').getAttribute('data-clicked'), 'true');
      const hand = frame.locator('tp-recording-cursor');
      assert.equal(await hand.count(), 1);
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).left), '150px');
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).top), '100px');
      assert.equal(
        await page.locator('tp-recording-cursor').evaluate((element) => getComputedStyle(element).opacity),
        '0',
      );
      await page.mouse.move(40, 40);
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).opacity), '0');
      assert.equal(
        await page.locator('tp-recording-cursor').evaluate((element) => getComputedStyle(element).opacity),
        '1',
      );
    } finally {
      await browser.close();
    }
  },
);

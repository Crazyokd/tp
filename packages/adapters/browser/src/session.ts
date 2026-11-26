import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AdapterSession, AdapterSessionContext, LeafTickContext, RuntimeLeaf } from '@tp/contract/adapter';
import type { TickResult } from '@tp/contract';
import {
  chromium,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Route,
  type Request,
} from 'playwright';

import { browserMetrics } from './metrics.ts';
import { installRecordingCursor } from './recording-cursor.ts';

const SCREENSHOT_NAME = /^[A-Za-z0-9._-]+$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const EXPECT_ASSERTIONS = new Set([
  'visible',
  'hidden',
  'enabled',
  'disabled',
  'checked',
  'unchecked',
  'value',
  'attribute',
  'count',
]);
const MOUSE_ACTIONS = new Set(['move', 'down', 'up', 'drag']);
const ROUTE_ACTIONS = new Set(['abort', 'fulfill', 'hold']);
const RELEASE_ACTIONS = new Set(['fulfill', 'abort', 'continue']);

export type BrowserSessionDependencies = {
  workspacePath?: string;
};

type RouteTable = {
  held: Map<string, Route[]>;
  observed: Map<
    string,
    { requests: Request[]; bytes: number; overflow: boolean; listener: (request: Request) => void }
  >;
};

type SessionOptions = {
  origin: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  initScript?: string;
};

export async function createSession(
  context: AdapterSessionContext,
  dependencies: BrowserSessionDependencies = {},
): Promise<AdapterSession> {
  const actor = context.actor;
  assertRecordingActor(actor);
  const workspacePath = dependencies.workspacePath ?? context.resourceRoot;
  const options = parseSessionInput(context.input);
  const videoDir = join(context.resourceRoot, 'browser', actor, `work-${randomUUID()}`);
  await mkdir(videoDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let navigationError: Error | undefined;
  let lifecycle: 'open' | 'closed' = 'open';
  let browserContext: BrowserContext;
  let page: Page;
  try {
    browserContext = await browser.newContext(contextOptions(options, videoDir));
    await browserContext.addInitScript(installRecordingCursor);
    await browserContext.route('**/*', async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.fallback();
        return;
      }
      let frame;
      try {
        frame = request.frame();
      } catch {
        /* A popup navigation may not have a frame yet. */
      }
      if (!frame || frame.page() !== page) {
        navigationError = new Error(
          'navigation must belong to the session origin and its managed page; popup navigation is not supported',
        );
        await route.abort('blockedbyclient');
        return;
      }
      if (frame.parentFrame() !== null) {
        await route.fallback();
        return;
      }
      if (new URL(request.url()).origin !== options.origin) {
        navigationError = new Error(
          `navigation must stay on the session origin ${options.origin}; received ${request.url()}`,
        );
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    });
    if (options.initScript) await browserContext.addInitScript(options.initScript);
    page = await browserContext.newPage();
    // Playwright routes see only the first redirect hop. Inspect every document response before Chromium follows it.
    const cdp = await browserContext.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    cdp.on(
      'Fetch.requestPaused',
      (event: {
        requestId: string;
        frameId: string;
        request: { url: string };
        responseStatusCode?: number;
        responseHeaders?: Array<{ name: string; value: string }>;
      }) => {
        void (async () => {
          const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
          if (
            event.frameId === frameTree.frame.id &&
            event.responseStatusCode !== undefined &&
            event.responseStatusCode >= 300 &&
            event.responseStatusCode < 400 &&
            location &&
            new URL(location, event.request.url).origin !== options.origin
          ) {
            navigationError = new Error(
              `redirect must stay on the session origin ${options.origin}; received ${location}`,
            );
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          } else {
            await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
          }
        })().catch((error: unknown) => {
          if (lifecycle !== 'closed') navigationError = new Error(`origin guard failed: ${errorMessage(error)}`);
        });
      },
    );
    await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }

  const routes: RouteTable = { held: new Map(), observed: new Map() };
  let executeTail = Promise.resolve();
  const active = new Map<string, AbortController>();

  function tick(node: RuntimeLeaf, execution: LeafTickContext): Promise<TickResult> {
    if (lifecycle !== 'open') {
      browserMetrics().ticks.inc(1, { capability: node.capability, status: 'FAILURE' });
      return Promise.resolve(failure('Browser session is closed; tick is not accepted'));
    }
    const result = executeTail.then(() => {
      if (lifecycle !== 'open') {
        browserMetrics().ticks.inc(1, { capability: node.capability, status: 'FAILURE' });
        return failure('Browser session is closed; queued tick was not started');
      }
      return executeOne(node, execution);
    });
    executeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function halt(leaf: RuntimeLeaf): Promise<void> {
    active.get(leaf.path)?.abort(new Error('halted'));
  }

  function recordTick(capability: string, status: 'SUCCESS' | 'FAILURE'): void {
    browserMetrics().ticks.inc(1, { capability, status });
  }

  async function executeOne(node: RuntimeLeaf, execution: LeafTickContext): Promise<TickResult> {
    if (node.actor !== actor) {
      recordTick(node.capability, 'FAILURE');
      return failure(`Browser actor must be ${actor}; received ${String(node.actor)}`);
    }
    const controller = new AbortController();
    active.set(node.path, controller);
    try {
      if (navigationError) throw navigationError;
      // Touch input must finish cancellation before the next queued tick starts.
      const output =
        node.capability === 'browser.touch_drag'
          ? await touchDrag(page, execution.input, controller.signal)
          : await withAbort(controller.signal, () =>
              runCapability(node, execution.input, page, workspacePath, actor, routes, options.origin),
            );
      if (lifecycle !== 'open') {
        recordTick(node.capability, 'FAILURE');
        return failure('Browser session is closed; tick was interrupted');
      }
      if (navigationError) throw navigationError;
      recordTick(node.capability, 'SUCCESS');
      return { status: 'SUCCESS', output };
    } catch (error) {
      recordTick(node.capability, 'FAILURE');
      return failure(errorMessage(navigationError ?? error));
    } finally {
      active.delete(node.path);
    }
  }

  async function cleanup(): Promise<void> {
    lifecycle = 'closed';
    for (const controller of active.values()) controller.abort(new Error('halted'));
    await executeTail.catch(() => undefined);
    await abortHeld(routes);
    for (const observed of routes.observed.values()) page.off('request', observed.listener);
    routes.observed.clear();
    try {
      await sealRecording(context, actor, page, browserContext);
    } finally {
      await browser.close();
      browserMetrics().cleanups.inc();
    }
  }

  browserMetrics().sessions.inc();
  return { tick, halt, cleanup };
}

async function runCapability(
  node: RuntimeLeaf,
  input: Record<string, unknown>,
  page: Page,
  workspacePath: string,
  actor: string,
  routes: RouteTable,
  origin: string,
): Promise<Record<string, unknown>> {
  switch (node.capability) {
    case 'browser.watch_requests':
    case 'browser.expect_requests':
      return observeRequests(node.capability, input, page, routes);
    case 'browser.goto': {
      const url = resolvePageUrl(origin, input.url);
      await page.goto(url);
      return { url: page.url() };
    }
    case 'browser.click':
      return click(page, input);
    case 'browser.fill': {
      const value = input.value;
      if (typeof value !== 'string') throw new Error('value must be a string');
      await page.locator(requiredString(input.selector, 'selector')).fill(value);
      return { filled: true };
    }
    case 'browser.expect_text': {
      const expected = requiredString(input.text, 'text');
      const locator = page.locator(requiredString(input.selector, 'selector'));
      const text = (await locator.innerText()).trim();
      if (!text.includes(expected)) {
        throw new Error(`visible text ${JSON.stringify(text)} does not include ${JSON.stringify(expected)}`);
      }
      return { text };
    }
    case 'browser.screenshot': {
      const name = requiredString(input.name, 'name');
      if (!SCREENSHOT_NAME.test(name)) {
        throw new Error(`screenshot name may only contain letters, digits, ".", "_" and "-"; received ${name}`);
      }
      const path = `browser/${actor}/${name}.png`;
      await mkdir(join(workspacePath, 'browser', actor), { recursive: true });
      await page.screenshot({ path: join(workspacePath, path) });
      return { path };
    }
    case 'browser.canvas_probe':
      return canvasProbe(page, input);
    case 'browser.expect':
      return expectState(page, input);
    case 'browser.expect_url': {
      const source = requiredString(input.regex, 'regex');
      let compiled: RegExp;
      try {
        compiled = new RegExp(source);
      } catch {
        throw new Error(`regex is not a valid regular expression; received ${source}`);
      }
      const url = page.url();
      const match = compiled.exec(url);
      if (!match) {
        throw new Error(`url ${JSON.stringify(url)} does not match ${source}`);
      }
      return { url, ...(match[1] === undefined ? {} : { capture: match[1] }) };
    }
    case 'browser.reload': {
      await page.reload();
      return { url: page.url() };
    }
    case 'browser.mouse':
      return mouse(page, input);
    case 'browser.route':
      return installRoute(page, input, routes, origin);
    case 'browser.unroute':
      return removeRoute(page, requiredString(input.url, 'url'), routes);
    case 'browser.release':
      return releaseRoute(input, routes);
    default:
      throw new Error(`unknown browser capability ${node.capability}`);
  }
}

async function click(page: Page, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const locator = page.locator(requiredString(input.selector, 'selector'));
  const waitUrl = optionalString(input.waitResponseUrl, 'waitResponseUrl');
  const method = optionalString(input.waitResponseMethod, 'waitResponseMethod');
  const status = optionalInteger(input.waitResponseStatus, 'waitResponseStatus', 100, 599);
  const expectedBody = optionalObject(input.waitResponseBody, 'waitResponseBody');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new Error('force must be boolean');
  const options = input.force === undefined ? undefined : { force: input.force as boolean };
  if ((method !== undefined || status !== undefined || expectedBody !== undefined) && waitUrl === undefined) {
    throw new Error('waitResponseUrl is required when waitResponseMethod or waitResponseStatus is set');
  }
  if (method !== undefined && !HTTP_METHODS.has(method)) {
    throw new Error(`waitResponseMethod must be GET, POST, PUT, PATCH or DELETE; received ${method}`);
  }
  if (waitUrl === undefined) {
    await locator.click(options);
    return { clicked: true };
  }
  const pending = page.waitForResponse((response) => {
    if (method !== undefined && response.request().method() !== method) return false;
    if (status !== undefined && response.status() !== status) return false;
    return matchResponseUrl(response.url(), waitUrl);
  });
  const [response] = await Promise.all([pending, locator.click(options)]);
  const responseBody = response.headers()['content-type']?.includes('json') ? await response.json() : undefined;
  if (expectedBody !== undefined && !containsFields(responseBody, expectedBody))
    throw new Error('response body does not match expected fields');
  return {
    clicked: true,
    responseStatus: response.status(),
    responseUrl: response.url(),
    ...(responseBody !== undefined &&
    responseBody !== null &&
    typeof responseBody === 'object' &&
    !Array.isArray(responseBody)
      ? { responseBody }
      : {}),
  };
}

function containsFields(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => containsFields(actual[i], v))
    );
  if (expected !== null && typeof expected === 'object') {
    return (
      actual !== null &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(
        ([k, v]) => Object.hasOwn(actual, k) && containsFields((actual as Record<string, unknown>)[k], v),
      )
    );
  }
  return actual === expected;
}

function optionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function observeRequests(
  capability: string,
  input: Record<string, unknown>,
  page: Page,
  routes: RouteTable,
): Record<string, unknown> {
  const url = requiredString(input.url, 'url');
  const method = requiredString(input.method, 'method');
  if (!HTTP_METHODS.has(method)) throw new Error('method is not a declared HTTP method');
  const key = `${method} ${url}`;
  if (capability === 'browser.watch_requests') {
    const previous = routes.observed.get(key);
    if (previous) page.off('request', previous.listener);
    const requests: Request[] = [];
    const observed = { requests, bytes: 0, overflow: false, listener: (_request: Request) => {} };
    const listener = (request: Request) => {
      if (request.method() !== method || !matchResponseUrl(request.url(), url) || observed.overflow) return;
      observed.bytes += request.postDataBuffer()?.length ?? 0;
      if (requests.length >= 1000 || observed.bytes > 8 * 1024 * 1024) {
        observed.overflow = true;
        return;
      }
      requests.push(request);
    };
    observed.listener = listener;
    routes.observed.set(key, observed);
    page.on('request', listener);
    return {};
  }
  const observed = routes.observed.get(key);
  if (!observed) throw new Error(`request observation is not registered: ${key}`);
  if (observed.overflow) throw new Error(`request observation exceeded 1000 requests or 8 MiB: ${key}`);
  const count = optionalInteger(input.count, 'count', 0, Number.MAX_SAFE_INTEGER);
  if (count === undefined) throw new Error('count is required');
  const expectedBody = optionalObject(input.expectedBody, 'expectedBody');
  const requests =
    expectedBody === undefined
      ? observed.requests
      : observed.requests.filter((request) => containsFields(request.postDataJSON(), expectedBody));
  if (requests.length !== count) throw new Error(`request count ${requests.length} does not equal ${count}: ${key}`);
  const last = requests.at(-1);
  const body = last?.headers()['content-type']?.includes('json') ? last.postDataJSON() : undefined;
  const previousBody = optionalObject(input.previousBody, 'previousBody');
  if ((previousBody === undefined) !== (input.changedFields === undefined))
    throw new Error('previousBody and changedFields must be provided together');
  if (previousBody !== undefined) {
    const fields = input.changedFields;
    if (
      !Array.isArray(fields) ||
      fields.length === 0 ||
      !fields.every((field) => typeof field === 'string' && field.trim() !== '')
    )
      throw new Error('changedFields must list fields');
    const current = optionalObject(body, 'request body');
    if (
      current === undefined ||
      !fields.every((field) => Object.hasOwn(previousBody, field) && Object.hasOwn(current, field))
    )
      throw new Error('changed fields must exist in both request bodies');
    for (const field of fields) {
      for (const value of [previousBody[field], current[field]])
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error('changed request fields must be finite numbers');
    }
    if (fields.every((field) => JSON.stringify(previousBody[field]) === JSON.stringify(current[field])))
      throw new Error('request fields did not change');
  }
  return {
    count: requests.length,
    ...(body !== null && typeof body === 'object' && !Array.isArray(body) ? { body } : {}),
  };
}

async function canvasProbe(page: Page, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const locator = page.locator(requiredString(input.selector, 'selector'));
  const minimumWidth = optionalInteger(input.minimumWidth, 'minimumWidth', 0, Number.MAX_SAFE_INTEGER);
  const minimumHeight = optionalInteger(input.minimumHeight, 'minimumHeight', 0, Number.MAX_SAFE_INTEGER);
  const minimumOccupied = optionalInteger(
    input.minimumOccupiedPixels,
    'minimumOccupiedPixels',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const minimumCenter = optionalInteger(
    input.minimumCenterOccupiedPixels,
    'minimumCenterOccupiedPixels',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const previousHash = optionalInteger(input.previousHash, 'previousHash', 0, Number.MAX_SAFE_INTEGER);
  const expectedHash = optionalInteger(input.expectedHash, 'expectedHash', 0, Number.MAX_SAFE_INTEGER);
  const greaterThanOccupiedPixels = optionalInteger(
    input.greaterThanOccupiedPixels,
    'greaterThanOccupiedPixels',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  await locator.waitFor({ state: 'visible' });
  const encoded = (
    await locator.screenshot({ style: 'tp-recording-cursor { visibility: hidden !important; }' })
  ).toString('base64');
  const probe = (await page.evaluate(
    (base64) =>
      new Function(
        'base64',
        `return (async () => {
          const response = await fetch(\`data:image/png;base64,\${base64}\`);
          const bitmap = await createImageBitmap(await response.blob());
          const sourceWidth = bitmap.width;
          const sourceHeight = bitmap.height;
          const width = Math.min(180, bitmap.width);
          const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
          const sample = document.createElement('canvas');
          sample.width = width;
          sample.height = height;
          const context = sample.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('2d canvas context is unavailable');
          context.drawImage(bitmap, 0, 0, width, height);
          bitmap.close();
          const pixels = context.getImageData(0, 0, width, height).data;
          const colors = new Map();
          let hash = 2166136261;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const key = ((pixels[offset] >> 4) << 8) | ((pixels[offset + 1] >> 4) << 4) | (pixels[offset + 2] >> 4);
            colors.set(key, (colors.get(key) || 0) + 1);
            hash = Math.imul(hash ^ key, 16777619) >>> 0;
          }
          const background = [...colors.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || 0;
          const br = ((background >> 8) & 15) << 4;
          const bg = ((background >> 4) & 15) << 4;
          const bb = (background & 15) << 4;
          let occupiedPixels = 0;
          let centerOccupiedPixels = 0;
          for (let offset = 0, index = 0; offset < pixels.length; offset += 4, index += 1) {
            const difference =
              Math.abs(pixels[offset] - br) + Math.abs(pixels[offset + 1] - bg) + Math.abs(pixels[offset + 2] - bb);
            if (difference <= 48) continue;
            occupiedPixels += 1;
            const px = index % width;
            const py = Math.floor(index / width);
            if (Math.abs(px - width / 2) <= width * 0.06 && Math.abs(py - height / 2) <= height * 0.08) {
              centerOccupiedPixels += 1;
            }
          }
          return { hash, occupiedPixels, centerOccupiedPixels, width: sourceWidth, height: sourceHeight };
        })();`,
      )(base64),
    encoded,
  )) as {
    hash: number;
    occupiedPixels: number;
    centerOccupiedPixels: number;
    width: number;
    height: number;
  };
  if (minimumWidth !== undefined && probe.width < minimumWidth) {
    throw new Error(`canvas width ${probe.width} is below ${minimumWidth}`);
  }
  if (minimumHeight !== undefined && probe.height < minimumHeight) {
    throw new Error(`canvas height ${probe.height} is below ${minimumHeight}`);
  }
  if (minimumOccupied !== undefined && probe.occupiedPixels < minimumOccupied) {
    throw new Error(`canvas occupiedPixels ${probe.occupiedPixels} is below ${minimumOccupied}`);
  }
  if (minimumCenter !== undefined && probe.centerOccupiedPixels < minimumCenter) {
    throw new Error(`canvas centerOccupiedPixels ${probe.centerOccupiedPixels} is below ${minimumCenter}`);
  }
  if (previousHash !== undefined && probe.hash === previousHash) {
    throw new Error(`canvas hash ${probe.hash} did not change`);
  }
  if (expectedHash !== undefined && probe.hash !== expectedHash)
    throw new Error(`canvas hash ${probe.hash} does not equal ${expectedHash}`);
  if (greaterThanOccupiedPixels !== undefined && probe.occupiedPixels <= greaterThanOccupiedPixels)
    throw new Error('canvas occupied pixels did not increase');
  return probe;
}

async function expectState(page: Page, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const locator = page.locator(requiredString(input.selector, 'selector'));
  const assertion = requiredString(input.assertion, 'assertion');
  if (!EXPECT_ASSERTIONS.has(assertion)) {
    throw new Error(`assertion is not a declared browser.expect value; received ${assertion}`);
  }
  const expected = optionalText(input.expected, 'expected');
  const attribute = optionalString(input.attribute, 'attribute');
  const count = optionalInteger(input.count, 'count', 0, Number.MAX_SAFE_INTEGER);
  switch (assertion) {
    case 'visible':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'visible' });
      return { matched: true };
    case 'hidden':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'hidden' });
      return { matched: true };
    case 'enabled':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'visible' });
      if (!(await locator.isEnabled())) throw new Error(`element ${String(input.selector)} is not enabled`);
      return { matched: true };
    case 'disabled':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'visible' });
      if (await locator.isEnabled()) throw new Error(`element ${String(input.selector)} is not disabled`);
      return { matched: true };
    case 'checked':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'visible' });
      if (!(await locator.isChecked())) throw new Error(`element ${String(input.selector)} is not checked`);
      return { matched: true };
    case 'unchecked':
      assertAbsent({ expected, attribute, count }, assertion);
      await locator.waitFor({ state: 'visible' });
      if (await locator.isChecked()) throw new Error(`element ${String(input.selector)} is checked`);
      return { matched: true };
    case 'value': {
      assertAbsent({ attribute, count }, assertion);
      if (expected === undefined) throw new Error('expected is required when assertion is value');
      await locator.waitFor({ state: 'visible' });
      const actual = await locator.inputValue();
      if (actual !== expected) {
        throw new Error(`value ${JSON.stringify(actual)} does not equal ${JSON.stringify(expected)}`);
      }
      return { matched: true };
    }
    case 'attribute': {
      assertAbsent({ count }, assertion);
      if (attribute === undefined) throw new Error('attribute is required when assertion is attribute');
      await locator.waitFor({ state: 'attached' });
      const actual = await locator.getAttribute(attribute);
      if (expected === undefined) {
        if (actual === null) throw new Error(`attribute ${attribute} is missing`);
        return { matched: true };
      }
      if (actual !== expected) {
        throw new Error(`attribute ${attribute} ${JSON.stringify(actual)} does not equal ${JSON.stringify(expected)}`);
      }
      return { matched: true };
    }
    case 'count': {
      assertAbsent({ expected, attribute }, assertion);
      if (count === undefined) throw new Error('count is required when assertion is count');
      const actual = await locator.count();
      if (actual !== count) {
        throw new Error(`count ${actual} does not equal ${count}`);
      }
      return { matched: true };
    }
    default:
      throw new Error(`assertion is not a declared browser.expect value; received ${assertion}`);
  }
}

async function mouse(page: Page, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = requiredString(input.action, 'action');
  if (!MOUSE_ACTIONS.has(action)) {
    throw new Error(`action is not a declared browser.mouse value; received ${action}`);
  }
  const locator = page.locator(requiredString(input.selector, 'selector'));
  const from = await pointOn(locator, requiredRatio(input.xRatio, 'xRatio'), requiredRatio(input.yRatio, 'yRatio'));
  const toX = optionalRatio(input.toXRatio, 'toXRatio');
  const toY = optionalRatio(input.toYRatio, 'toYRatio');
  const steps = optionalInteger(input.steps, 'steps', 1, Number.MAX_SAFE_INTEGER);
  if (action !== 'drag') {
    if (toX !== undefined || toY !== undefined || steps !== undefined) {
      throw new Error('toXRatio, toYRatio and steps are only allowed when action is drag');
    }
    if (action === 'move') await page.mouse.move(from.x, from.y);
    if (action === 'down') await page.mouse.down();
    if (action === 'up') await page.mouse.up();
    return { done: true };
  }
  if (toX === undefined || toY === undefined) {
    throw new Error('toXRatio and toYRatio are required when action is drag');
  }
  const to = await pointOn(locator, toX, toY);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, steps === undefined ? undefined : { steps });
  await page.mouse.up();
  return { done: true };
}

async function touchDrag(
  page: Page,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const x = requiredRatio(input.xRatio, 'xRatio');
  const y = requiredRatio(input.yRatio, 'yRatio');
  const toX = requiredRatio(input.toXRatio, 'toXRatio');
  const toY = requiredRatio(input.toYRatio, 'toYRatio');
  const steps = optionalInteger(input.steps, 'steps', 1, Number.MAX_SAFE_INTEGER);
  if (steps === undefined) throw new Error('steps is required');
  const locator = page.locator(requiredString(input.selector, 'selector'));
  const [from, to] = await withAbort(signal, () => Promise.all([pointOn(locator, x, y), pointOn(locator, toX, toY)]));
  signal.throwIfAborted();
  const cdp = await page.context().newCDPSession(page);
  let touching = false;
  try {
    signal.throwIfAborted();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    touching = true;
    for (let step = 1; step <= steps; step += 1) {
      signal.throwIfAborted();
      const ratio = step / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }],
      });
    }
    signal.throwIfAborted();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    touching = false;
    return { done: true };
  } finally {
    try {
      if (touching) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  }
}

async function installRoute(
  page: Page,
  input: Record<string, unknown>,
  routes: RouteTable,
  origin: string,
): Promise<Record<string, unknown>> {
  const url = requiredString(input.url, 'url');
  const action = requiredString(input.action, 'action');
  if (!ROUTE_ACTIONS.has(action)) {
    throw new Error(`action is not a declared browser.route value; received ${action}`);
  }
  const status = optionalInteger(input.status, 'status', 100, 599);
  const body = optionalText(input.body, 'body');
  const contentType = optionalString(input.contentType, 'contentType');
  const times = optionalInteger(input.times, 'times', 1, Number.MAX_SAFE_INTEGER);
  if (action !== 'fulfill' && (status !== undefined || body !== undefined || contentType !== undefined)) {
    throw new Error('status, body and contentType are only allowed when action is fulfill');
  }
  if (action === 'fulfill' && status === undefined) {
    throw new Error('status is required when action is fulfill');
  }
  const method = optionalString(input.method, 'method');
  if (method !== undefined && !HTTP_METHODS.has(method)) throw new Error('method is not a declared HTTP method');
  await removeRoute(page, url, routes);
  let matched = 0;
  if (action === 'hold') routes.held.set(url, []);
  await page.route(url, async (route) => {
    // Page mocks run before context guards; foreign documents must reach the guard.
    if (route.request().isNavigationRequest() && new URL(route.request().url()).origin !== origin) {
      let frame;
      try {
        frame = route.request().frame();
      } catch {
        /* Let the context guard reject an unowned navigation. */
      }
      if (!frame || frame.parentFrame() === null) return route.fallback();
    }
    if ((method !== undefined && route.request().method() !== method) || (times !== undefined && matched >= times)) {
      await route.fallback();
      return;
    }
    matched += 1;
    if (action === 'hold') {
      const pending = routes.held.get(url);
      if (!pending) throw new Error(`held route was removed: ${url}`);
      pending.push(route);
    } else if (action === 'abort') {
      await route.abort();
    } else {
      await route.fulfill({ status, body: body ?? '', contentType });
    }
  });
  return { routed: true };
}

async function removeRoute(page: Page, url: string, routes: RouteTable): Promise<Record<string, unknown>> {
  const pending = routes.held.get(url) ?? [];
  routes.held.delete(url);
  for (const route of pending) await route.abort().catch(() => undefined);
  await page.unroute(url).catch(() => undefined);
  return { unrouted: true };
}

async function releaseRoute(input: Record<string, unknown>, routes: RouteTable): Promise<Record<string, unknown>> {
  const url = requiredString(input.url, 'url');
  const action = requiredString(input.action, 'action');
  if (!RELEASE_ACTIONS.has(action)) {
    throw new Error(`action is not a declared browser.release value; received ${action}`);
  }
  const status = optionalInteger(input.status, 'status', 100, 599);
  const body = optionalText(input.body, 'body');
  const contentType = optionalString(input.contentType, 'contentType');
  const expectedRequestText = optionalString(input.expectedRequestText, 'expectedRequestText');
  if (action !== 'fulfill' && (status !== undefined || body !== undefined || contentType !== undefined)) {
    throw new Error('status, body and contentType are only allowed when action is fulfill');
  }
  if (action === 'fulfill' && status === undefined) {
    throw new Error('status is required when action is fulfill');
  }
  const pending = routes.held.get(url) ?? [];
  const route = pending.shift();
  if (!route) throw new Error(`no held request for ${url}`);
  const requestBody = route.request().postData() ?? '';
  if (expectedRequestText !== undefined && !requestBody.includes(expectedRequestText)) {
    await route.abort().catch(() => undefined);
    throw new Error(
      `held request body ${JSON.stringify(requestBody)} does not include ${JSON.stringify(expectedRequestText)}`,
    );
  }
  if (action === 'abort') await route.abort();
  else if (action === 'continue') await route.continue();
  else await route.fulfill({ status, body: body ?? '', contentType });
  return { released: true, requestBody };
}

async function abortHeld(routes: RouteTable): Promise<void> {
  for (const pending of routes.held.values()) {
    for (const route of pending) await route.abort().catch(() => undefined);
  }
  routes.held.clear();
}

function parseSessionInput(input: Record<string, unknown>): SessionOptions {
  const width = optionalInteger(input.viewportWidth, 'viewportWidth', 1, Number.MAX_SAFE_INTEGER);
  const height = optionalInteger(input.viewportHeight, 'viewportHeight', 1, Number.MAX_SAFE_INTEGER);
  if ((width === undefined) !== (height === undefined)) {
    throw new Error('viewportWidth and viewportHeight must be set together');
  }
  return {
    origin: requiredOrigin(input.origin),
    viewport: width === undefined || height === undefined ? undefined : { width, height },
    locale: optionalString(input.locale, 'locale'),
    timezoneId: optionalString(input.timezoneId, 'timezoneId'),
    initScript: optionalString(input.initScript, 'initScript'),
  };
}

function contextOptions(options: SessionOptions, videoDir: string): BrowserContextOptions {
  const size = options.viewport ?? { width: 1280, height: 720 };
  const context: BrowserContextOptions = {
    recordVideo: { dir: videoDir, size },
  };
  if (options.viewport) context.viewport = options.viewport;
  if (options.locale) context.locale = options.locale;
  if (options.timezoneId) context.timezoneId = options.timezoneId;
  return context;
}

function assertRecordingActor(actor: string): void {
  if (actor.trim().length === 0 || actor.includes('/') || actor.includes('\\') || actor.includes('..')) {
    throw new Error(`Browser recording actor must not be empty or contain '/', '\\', or '..'; received ${actor}`);
  }
}

async function sealRecording(
  context: AdapterSessionContext,
  actor: string,
  page: Page,
  browserContext: BrowserContext,
): Promise<void> {
  const video = page.video();
  await page.close();
  await browserContext.close();
  if (!video) throw new Error('Browser session produced no video');
  const path = `browser/${actor}/recording.webm`;
  await video.saveAs(join(context.resourceRoot, path));
  context.recordArtifact({
    name: `${actor} 录屏`,
    mediaType: 'video/webm',
    path,
  });
}

async function pointOn(locator: Locator, xRatio: number, yRatio: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no bounding box');
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
}

function matchResponseUrl(actual: string, spec: string): boolean {
  if (!spec.includes('*')) return actual.includes(spec);
  const escaped = spec
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE::/g, '.*');
  return new RegExp(`^${escaped}$`).test(actual);
}

function assertAbsent(values: { expected?: string; attribute?: string; count?: number }, assertion: string): void {
  if (values.expected !== undefined) throw new Error(`expected is not allowed when assertion is ${assertion}`);
  if (values.attribute !== undefined) throw new Error(`attribute is not allowed when assertion is ${assertion}`);
  if (values.count !== undefined) throw new Error(`count is not allowed when assertion is ${assertion}`);
}

function requiredOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Browser session input.origin is required');
  }
  if (value.trim() !== value) {
    throw new Error('Browser session input.origin must be an absolute http(s) URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Browser session input.origin must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Browser session input.origin must be an absolute http(s) URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Browser session input.origin must not include credentials');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error('Browser session input.origin must not include a path');
  }
  return url.origin;
}

function resolvePageUrl(origin: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    throw new Error(`url must be a path starting with /; received ${String(value)}`);
  }
  const url = new URL(value, `${origin}/`);
  if (url.origin !== origin) {
    throw new Error(`url must stay on the session origin; received ${value}`);
  }
  return url.href;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function requiredRatio(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
  return value;
}

function optionalRatio(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredRatio(value, name);
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function failure(error: string): TickResult {
  return { status: 'FAILURE', output: { error } };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error);
  return text.trim() || 'unknown browser adapter error';
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AdapterSession, AdapterSessionContext, LeafTickContext, RuntimeLeaf } from '@tp/contract/adapter';
import type { TickResult } from '@tp/contract';
import { chromium, type Browser, type Page } from 'playwright';

import { browserMetrics } from './metrics.ts';

const SCREENSHOT_NAME = /^[A-Za-z0-9._-]+$/;

export type BrowserSessionDependencies = {
  workspacePath?: string;
};

export async function createSession(
  context: AdapterSessionContext,
  dependencies: BrowserSessionDependencies = {},
): Promise<AdapterSession> {
  const actor = context.actor;
  const workspacePath = dependencies.workspacePath ?? context.resourceRoot;
  const browser = await chromium.launch({ headless: true });
  let page: Page;
  try {
    page = await browser.newPage();
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }

  let lifecycle: 'open' | 'closed' = 'open';
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
      const output = await withAbort(controller.signal, () =>
        runCapability(node, execution.input, page, workspacePath),
      );
      if (lifecycle !== 'open') {
        recordTick(node.capability, 'FAILURE');
        return failure('Browser session is closed; tick was interrupted');
      }
      recordTick(node.capability, 'SUCCESS');
      return { status: 'SUCCESS', output };
    } catch (error) {
      recordTick(node.capability, 'FAILURE');
      return failure(errorMessage(error));
    } finally {
      active.delete(node.path);
    }
  }

  async function cleanup(): Promise<void> {
    lifecycle = 'closed';
    for (const controller of active.values()) controller.abort(new Error('halted'));
    await executeTail.catch(() => undefined);
    await closeBrowser(browser, page);
    browserMetrics().cleanups.inc();
  }

  browserMetrics().sessions.inc();
  return { tick, halt, cleanup };
}

async function runCapability(
  node: RuntimeLeaf,
  input: Record<string, unknown>,
  page: Page,
  workspacePath: string,
): Promise<Record<string, unknown>> {
  switch (node.capability) {
    case 'browser.goto': {
      const url = parseHttpUrl(input.url);
      await page.goto(url);
      return { url: page.url() };
    }
    case 'browser.click': {
      await page.locator(requiredString(input.selector, 'selector')).click();
      return { clicked: true };
    }
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
      await mkdir(workspacePath, { recursive: true });
      const path = `${name}.png`;
      await page.screenshot({ path: join(workspacePath, path) });
      return { path };
    }
    default:
      throw new Error(`unknown browser capability ${node.capability}`);
  }
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

function parseHttpUrl(value: unknown): string {
  const url = requiredString(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`url must be an absolute http/https URL; received ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Browser goto only accepts http/https; received ${parsed.protocol}`);
  }
  return parsed.href;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
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

async function closeBrowser(browser: Browser, page: Page): Promise<void> {
  await page.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

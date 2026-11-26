import { httpCaseWriteSchema, httpRunSchema } from '@tp/contract';
import { z } from 'zod';

import { TpApiError, type TpClient } from './http.ts';

export const waitForRunInputSchema = z
  .object({
    runId: z.string().trim().min(1),
    timeoutMs: z.number().int().min(1),
  })
  .strict();

const TERMINAL = new Set(['passed', 'failed', 'canceled']);

export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export async function createCaseAndRun(client: TpClient, input: unknown): Promise<{ case: unknown; batch: unknown }> {
  const body = httpCaseWriteSchema.parse(input);
  const created = (await client.invoke('createCase', { body })) as { id: string };
  try {
    const batch = await client.invoke('createBatch', { body: { caseIds: [created.id], trigger: { kind: 'mcp' } } });
    return { case: created, batch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = `createBatch failed after creating case ${created.id}: ${message}`;
    if (error instanceof TpApiError) throw new TpApiError(error.code, wrapped);
    throw new Error(wrapped, { cause: error });
  }
}

export async function waitForRun(client: TpClient, input: unknown, clock: Clock = systemClock): Promise<unknown> {
  const parsed = waitForRunInputSchema.parse(input);
  const deadline = clock.now() + parsed.timeoutMs;
  const abort = new AbortController();
  let lastStatus: string | undefined;
  const timeout = clock.sleep(Math.max(1, deadline - clock.now()), abort.signal).then(
    () => {
      abort.abort();
    },
    () => undefined,
  );
  try {
    for await (const value of client.watchRun(parsed.runId, { signal: abort.signal })) {
      const run = httpRunSchema.parse(value);
      lastStatus = run.status;
      if (TERMINAL.has(run.status)) return run;
    }
    throw new Error(`waitForRun connection closed with status ${lastStatus ?? 'unknown'}`);
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`waitForRun timed out with status ${lastStatus ?? 'unknown'}`);
    throw error;
  } finally {
    abort.abort();
    await timeout;
  }
}

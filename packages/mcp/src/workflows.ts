import { httpCaseWriteSchema } from '@tp/contract';
import { z } from 'zod';

import { TpApiError, type TpClient } from './http.ts';

export const WAIT_POLL_INTERVAL_MS = 500;

export const waitForRunInputSchema = z
  .object({
    runId: z.string().trim().min(1),
    timeoutMs: z.number().int().min(1),
  })
  .strict();

const TERMINAL = new Set(['passed', 'failed', 'canceled']);

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function createCaseAndRun(client: TpClient, input: unknown): Promise<{ case: unknown; run: unknown }> {
  const body = httpCaseWriteSchema.parse(input);
  const created = (await client.invoke('createCase', { body })) as { id: string };
  try {
    const run = await client.invoke('createRun', { body: { caseId: created.id } });
    return { case: created, run };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = `createRun failed after creating case ${created.id}: ${message}`;
    if (error instanceof TpApiError) throw new TpApiError(error.code, wrapped);
    throw new Error(wrapped, { cause: error });
  }
}

export async function waitForRun(client: TpClient, input: unknown, clock: Clock = systemClock): Promise<unknown> {
  const parsed = waitForRunInputSchema.parse(input);
  const deadline = clock.now() + parsed.timeoutMs;
  let lastStatus: string | undefined;
  while (true) {
    const run = (await client.invoke('getRun', { params: { id: parsed.runId } })) as { status: string };
    lastStatus = run.status;
    if (TERMINAL.has(run.status)) return run;
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw new Error(`waitForRun timed out with status ${lastStatus}`);
    await clock.sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
  }
}

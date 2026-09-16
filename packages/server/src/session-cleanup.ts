import type { AdapterSession } from '@tp/contract/adapter';
import { logger } from './log.ts';

const log = logger('worker');

export async function cleanupAdapterSessions(
  sessions: Iterable<AdapterSession>,
  options: { timeoutMs: number },
): Promise<string[]> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`session cleanup timeout must be finite and positive; received ${String(options.timeoutMs)}`);
  }
  const errors: string[] = [];
  const attempts = [...sessions].map(async (session) => {
    try {
      await session.cleanup();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    Promise.allSettled(attempts).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), options.timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!completed) {
    const message = `session cleanup timed out after ${options.timeoutMs}ms`;
    log.warn(message);
    errors.push(message);
  }
  return [...errors];
}

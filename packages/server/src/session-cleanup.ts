import type { AdapterSession } from '@tp/contract/adapter';
import { logger } from './log.ts';

const log = logger('worker');

// Adapters may need time to stop external resources before releasing their sessions.
export const DEFAULT_SESSION_CLEANUP_TIMEOUT_MS = 120_000;

export async function cleanupAdapterSessions(
  sessions: Iterable<AdapterSession>,
  options: { timeoutMs: number },
): Promise<string[]> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`session cleanup timeout must be finite and positive; received ${String(options.timeoutMs)}`);
  }
  const errors: string[] = [];
  let timedOut = false;
  const cleanup = (async () => {
    // A consumer may still use its provider's endpoint until cleanup completes.
    for (const session of [...sessions].reverse()) {
      if (timedOut) return;
      try {
        await session.cleanup();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return;
      }
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    cleanup.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, options.timeoutMs);
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

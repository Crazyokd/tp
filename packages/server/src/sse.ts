import type { IncomingMessage, ServerResponse } from 'node:http';

import { httpRunSchema, type LiveRun, type Run } from '@tp/contract';

export const SSE_HEARTBEAT_MS = 15_000;

export type RunWatchHub = {
  hasSubscribers(runId: string): boolean;
  subscribe(run: Run, req: IncomingMessage, res: ServerResponse, lastEventId: number | undefined): void;
  publish(run: LiveRun | Run): void;
};

type Subscriber = {
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
};

export function parseLastEventId(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('invalid Last-Event-ID');
  return Number(value);
}

export function toSseRun(run: LiveRun | Run): Run | undefined {
  const { definition: _definition, ...rest } = run as LiveRun;
  const parsed = httpRunSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
}

export function createRunWatchHub(heartbeatMs = SSE_HEARTBEAT_MS): RunWatchHub {
  const subscribers = new Map<string, Set<Subscriber>>();

  function drop(runId: string, subscriber: Subscriber): void {
    clearInterval(subscriber.heartbeat);
    const group = subscribers.get(runId);
    if (!group) return;
    group.delete(subscriber);
    if (group.size === 0) subscribers.delete(runId);
  }

  function flush(res: ServerResponse): void {
    const flushed = res as ServerResponse & { flush?: () => void };
    flushed.flush?.();
    res.socket?.uncork();
  }

  function writeChunk(res: ServerResponse, chunk: string): boolean {
    try {
      res.write(chunk);
      flush(res);
      return true;
    } catch {
      return false;
    }
  }

  function writeEvent(res: ServerResponse, run: Run): boolean {
    const parsed = httpRunSchema.safeParse(run);
    if (!parsed.success) return false;
    return writeChunk(res, `id: ${parsed.data.revision}\nevent: run\ndata: ${JSON.stringify(parsed.data)}\n\n`);
  }

  return {
    hasSubscribers: (runId) => subscribers.has(runId),
    subscribe(run, req, res, lastEventId) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      if (!writeChunk(res, ': connected\n\n')) {
        res.end();
        return;
      }
      if (lastEventId === undefined || run.revision > lastEventId) {
        if (!writeEvent(res, run) && lastEventId === undefined) {
          res.end();
          return;
        }
      }
      const subscriber: Subscriber = {
        res,
        heartbeat: setInterval(() => {
          if (!writeChunk(res, ': keepalive\n\n')) drop(run.id, subscriber);
        }, heartbeatMs),
      };
      subscriber.heartbeat.unref?.();
      const group = subscribers.get(run.id) ?? new Set<Subscriber>();
      group.add(subscriber);
      subscribers.set(run.id, group);
      const onClose = () => drop(run.id, subscriber);
      req.on('close', onClose);
      res.on('close', onClose);
      res.on('error', onClose);
    },

    publish(run) {
      const group = subscribers.get(run.id);
      if (!group) return;
      const snapshot = toSseRun(run);
      if (!snapshot) return;
      for (const subscriber of [...group]) {
        if (!writeEvent(subscriber.res, snapshot)) drop(run.id, subscriber);
      }
    },
  };
}

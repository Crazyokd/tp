import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AdapterManifest, AdapterModule } from '@tp/contract/adapter';
import type { TickResult } from '@tp/contract';

const runtimePorts = [
  { name: 'markerDir', direction: 'in' as const, schema: { type: 'string' }, required: false },
  { name: 'delayMs', direction: 'in' as const, schema: { type: 'number' }, required: false },
];
const errorPort = {
  name: 'error',
  direction: 'out' as const,
  schema: { type: 'string' },
  required: false,
};

export const manifest: AdapterManifest = {
  id: 'test',
  moduleEntry: import.meta.url,
  capabilities: [
    { key: 'test.pass', kind: 'Action', label: 'Pass', ports: runtimePorts },
    { key: 'test.fail', kind: 'Action', label: 'Fail', ports: [...runtimePorts, errorPort] },
    {
      key: 'test.invalid',
      kind: 'Action',
      label: 'Invalid',
      ports: [...runtimePorts, { name: 'ok', direction: 'out', schema: { type: 'boolean' }, required: false }],
    },
    {
      key: 'test.failed-invalid-output',
      kind: 'Action',
      label: 'Failed Invalid Output',
      ports: [...runtimePorts, { name: 'ok', direction: 'out', schema: { type: 'boolean' }, required: false }],
    },
    {
      key: 'test.passed-missing-output',
      kind: 'Action',
      label: 'Passed Missing Output',
      ports: [...runtimePorts, { name: 'ok', direction: 'out', schema: { type: 'boolean' }, required: false }],
    },
    { key: 'test.failed-function-error', kind: 'Action', label: 'Failed Function Error', ports: runtimePorts },
    {
      key: 'test.passed-with-error',
      kind: 'Action',
      label: 'Passed With Error',
      ports: [...runtimePorts, { name: 'ok', direction: 'out', schema: { type: 'boolean' }, required: false }],
    },
    { key: 'test.worker-fatal', kind: 'Action', label: 'Worker Fatal', ports: runtimePorts },
    {
      key: 'test.worker-fatal-hanging-cleanup',
      kind: 'Action',
      label: 'Worker Fatal Hanging Cleanup',
      ports: runtimePorts,
    },
    { key: 'test.record', kind: 'Action', label: 'Record', ports: runtimePorts },
  ],
};

export const createSession: AdapterModule['createSession'] = async (context) => {
  let cleanupMode: 'normal' | 'hang' = 'normal';
  const workspacePath = join(tmpdir(), 'tp-test', context.runId);
  const active = new Map<string, AbortController>();
  await mkdir(workspacePath, { recursive: true });
  await appendFile(join(workspacePath, 'session.log'), `session:${context.actor}\n`);
  return {
    async tick(node, execution) {
      if (node.capability === 'test.worker-fatal-hanging-cleanup') cleanupMode = 'hang';
      const markerDir = String(execution.input.markerDir ?? workspacePath);
      await mkdir(markerDir, { recursive: true });
      await appendFile(join(markerDir, 'events.log'), `execute:${node.actor}\n`);
      const controller = new AbortController();
      active.set(node.path, controller);
      try {
        const delayMs = Number(execution.input.delayMs ?? 0);
        if (Number.isFinite(delayMs) && delayMs > 0) {
          try {
            await abortableDelay(delayMs, controller.signal);
          } catch {
            if (node.capability.endsWith('.fail')) {
              return { status: 'FAILURE', output: { error: node.capability } };
            }
            return { status: 'FAILURE' };
          }
        }
        if (node.capability === 'test.worker-fatal' || node.capability === 'test.worker-fatal-hanging-cleanup') {
          cleanupMode = node.capability.endsWith('hanging-cleanup') ? 'hang' : 'normal';
          return new Promise<TickResult>(() => undefined);
        }
        if (node.capability.endsWith('.invalid')) {
          return { status: 'unknown', output: { ok: 'not-a-boolean' } } as unknown as TickResult;
        }
        if (node.capability === 'test.failed-invalid-output') {
          return { status: 'FAILURE', output: { ok: 'not-a-boolean' } };
        }
        if (node.capability === 'test.failed-function-error') {
          throw new Error('not cloneable');
        }
        if (node.capability === 'test.passed-with-error') {
          return { status: 'SUCCESS', output: { ok: true } };
        }
        if (node.capability === 'test.record') {
          await writeFile(join(context.resourceRoot, 'note.txt'), 'ok');
          context.recordArtifact({ name: 'note', mediaType: 'text/plain', path: 'note.txt' });
          return { status: 'SUCCESS' };
        }
        return failResult(node.capability);
      } finally {
        active.delete(node.path);
      }
    },
    async halt(leaf) {
      active.get(leaf.path)?.abort();
    },
    async cleanup() {
      for (const controller of active.values()) controller.abort();
      if (cleanupMode === 'hang') return new Promise<void>(() => undefined);
      await mkdir(workspacePath, { recursive: true });
      await appendFile(join(workspacePath, 'cleanup.log'), 'cleanup\n');
    },
  };
};

function failResult(capability: string): TickResult {
  if (capability.endsWith('.fail')) {
    return { status: 'FAILURE', output: { error: capability } };
  }
  return { status: 'SUCCESS' };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('halted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('halted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

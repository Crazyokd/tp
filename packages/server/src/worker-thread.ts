import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';

import type {
  AdapterManifest,
  AdapterModule,
  AdapterSession,
  AdapterSessionContext,
  LeafTickContext,
  RuntimeLeaf,
} from '@tp/contract/adapter';
import {
  appendRunArtifact,
  recordRunProgressEvent,
  failedRunError,
  type Artifact,
  type LiveRun,
  type NodeStatusResult,
  type RunStatus,
  type RunTree,
} from '@tp/contract';
import { isJsonValue } from '@tp/contract/json-schema';
import { logger } from './log.ts';
import { DEFAULT_TREE_TICK_INTERVAL_MS, executeTree, WorkerFatalError } from './bt.ts';
import { assembleSessionInput, MissingLeafInputError } from './leaf-ports.ts';
import { createRunArtifactStore } from './run-artifacts.ts';
import { cleanupAdapterSessions, DEFAULT_SESSION_CLEANUP_TIMEOUT_MS } from './session-cleanup.ts';

type RunMessage = {
  type: 'run';
  run: LiveRun;
  adapters: AdapterManifest[];
  workspaceRoot: string;
  sessionCleanupTimeoutMs?: number;
  treeTickIntervalMs?: number;
};

type CancelMessage = {
  type: 'cancel';
  runId: string;
};

type HostMessage = RunMessage | CancelMessage;

export type WorkerThreadResult = {
  status: RunStatus;
  tree: RunTree;
  revision: number;
  artifacts?: Artifact[];
  error?: string;
};

const log = logger('worker');

const port = parentPort;
if (!port) throw new Error('worker-thread must run inside a Worker');
const postMessage = port.postMessage.bind(port);

const adapterModules = new Map<string, AdapterModule>();
const pendingCancels = new Set<string>();
let current: { runId: string; controller: AbortController } | undefined;

port.on('message', (message: HostMessage) => {
  if (message.type === 'cancel') {
    log.info('cancel received', message.runId);
    if (current?.runId === message.runId) current.controller.abort(new Error('canceled'));
    else pendingCancels.add(message.runId);
    return;
  }
  if (message.type !== 'run') return;
  const controller = new AbortController();
  if (pendingCancels.delete(message.run.id)) controller.abort(new Error('canceled'));
  current = { runId: message.run.id, controller };
  executeRun(message, controller.signal)
    .then((result) => postMessage({ type: 'result', runId: message.run.id, result }))
    .catch((error: unknown) => {
      if (error instanceof WorkerFatalError) {
        postMessage({
          type: 'fatal',
          runId: message.run.id,
          error: nonEmptyError(error),
        });
        return;
      }
      throw error;
    })
    .finally(() => {
      if (current?.runId === message.run.id) current = undefined;
    });
});

postMessage({ type: 'ready' });

async function executeRun(message: RunMessage, signal: AbortSignal): Promise<WorkerThreadResult> {
  const sessions = new Map<string, AdapterSession>();
  const sessionReady = new Set<Promise<void>>();
  const resourceRoot = join(message.workspaceRoot, message.run.id);
  await mkdir(resourceRoot, { recursive: true });
  let revision = message.run.revision;
  const nextRevision = () => ++revision;
  let snapshot = { revision: message.run.revision, tree: message.run.tree };
  let artifacts: Artifact[] = [...message.run.artifacts];
  const store = createRunArtifactStore({
    resourceRoot,
    nextRevision,
    onRecord: (event) => {
      const next = appendRunArtifact({ revision: snapshot.revision, artifacts }, event);
      snapshot = { revision: next.revision, tree: snapshot.tree };
      artifacts = next.artifacts;
      postMessage({ type: 'artifact', runId: message.run.id, event });
    },
  });
  let result: WorkerThreadResult;
  let fatalError: WorkerFatalError | undefined;
  log.info('run started', message.run.id);
  try {
    const tree = await executeTree(message.run.definition, {
      capabilities: message.adapters.flatMap((adapter) =>
        adapter.capabilities.map((capability) => ({ ...capability, adapter: adapter.id })),
      ),
      adapter: (node, context, lookup) =>
        executeLeaf(message, node, sessions, context, lookup, sessionReady, resourceRoot, store.recordArtifact),
      initialBlackboard: message.run.blackboard,
      haltLeaf: async (node) => {
        await sessions.get(sessionKey(node.adapter, node.actor))?.halt(node);
      },
      onProgress: (event) => {
        recordRunProgressEvent(snapshot, event);
        postMessage({ type: 'progress', runId: message.run.id, event });
      },
      nextRevision,
      signal,
      tickIntervalMs: message.treeTickIntervalMs ?? DEFAULT_TREE_TICK_INTERVAL_MS,
    });
    result = {
      status: tree.status,
      tree: snapshot.tree,
      revision: snapshot.revision,
      artifacts,
      ...(tree.status === 'failed' ? { error: failedRunError(snapshot.tree) } : {}),
    };
  } catch (error) {
    if (error instanceof WorkerFatalError) fatalError = error;
    result = {
      status: 'failed',
      tree: snapshot.tree,
      revision: snapshot.revision,
      artifacts,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await Promise.allSettled([...sessionReady]);
  const cleanupTimeoutMs = message.sessionCleanupTimeoutMs ?? DEFAULT_SESSION_CLEANUP_TIMEOUT_MS;
  const cleanupErrors = await cleanupAdapterSessions(sessions.values(), {
    timeoutMs: cleanupTimeoutMs,
  });
  if (cleanupErrors.length > 0) {
    result.status = 'failed';
    const cleanupText = cleanupErrors.join('; ');
    result.error = result.error ? `${result.error}; ${cleanupText}` : cleanupText;
    log.warn('session cleanup failed', message.run.id, cleanupText);
  }
  await store.purgeUnregistered();
  result.revision = snapshot.revision;
  result.artifacts = artifacts;
  log.info('run ended', message.run.id, result.status);
  if (fatalError) {
    if (cleanupErrors.length === 0) throw fatalError;
    throw new WorkerFatalError(`${fatalError.message}; session cleanup errors: ${cleanupErrors.join('; ')}`, {
      cause: new AggregateError([fatalError, ...cleanupErrors.map((message) => new Error(message))]),
    });
  }
  return result;
}

function nonEmptyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'worker fatal error';
}

function sessionKey(adapterId: string, actor: string): string {
  return `${adapterId}::${actor}`;
}

async function executeLeaf(
  message: RunMessage,
  node: RuntimeLeaf,
  sessions: Map<string, AdapterSession>,
  context: LeafTickContext,
  lookup: (key: string) => unknown,
  sessionReady: Set<Promise<void>>,
  resourceRoot: string,
  recordArtifact: AdapterSessionContext['recordArtifact'],
): Promise<NodeStatusResult> {
  let notifyReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    notifyReady = resolve;
  });
  sessionReady.add(ready);
  try {
    return await executeLeafBody(message, node, sessions, context, lookup, notifyReady, resourceRoot, recordArtifact);
  } catch (error) {
    notifyReady();
    throw error;
  }
}

async function executeLeafBody(
  message: RunMessage,
  node: RuntimeLeaf,
  sessions: Map<string, AdapterSession>,
  context: LeafTickContext,
  lookup: (key: string) => unknown,
  notifyReady: () => void,
  resourceRoot: string,
  recordArtifact: AdapterSessionContext['recordArtifact'],
): Promise<NodeStatusResult> {
  const manifest = message.adapters.find((adapter) => adapter.id === node.adapter);
  if (!manifest) throw new WorkerFatalError(`adapter ${node.adapter} is not loaded`);
  const capability = manifest.capabilities.find((candidate) => candidate.key === node.capability);
  if (!capability) throw new WorkerFatalError(`adapter ${manifest.id} does not provide ${node.capability}`);

  const key = sessionKey(node.adapter, node.actor);
  let session = sessions.get(key);
  if (!session) {
    let module = adapterModules.get(manifest.moduleEntry);
    if (!module) {
      const imported = (await import(manifest.moduleEntry)) as Partial<AdapterModule> & { manifest?: AdapterManifest };
      if (typeof imported.createSession !== 'function') {
        throw new WorkerFatalError(`adapter ${manifest.id} does not export createSession`);
      }
      if (!imported.manifest || !isDeepStrictEqual(imported.manifest, manifest)) {
        throw new WorkerFatalError(`adapter ${manifest.id} exported manifest does not match its registry entry`);
      }
      module = imported as AdapterModule;
      adapterModules.set(manifest.moduleEntry, module);
    }
    try {
      const row = message.run.definition.sessions.find(
        (candidate) => candidate.adapter === node.adapter && candidate.actor === node.actor,
      );
      if (!row) throw new WorkerFatalError(`session ${node.adapter}/${node.actor} is not configured`);
      session = await module.createSession({
        runId: message.run.id,
        actor: node.actor,
        resourceRoot,
        recordArtifact,
        input: assembleSessionInput(row, manifest.session?.ports ?? [], lookup),
      });
    } catch (error) {
      if (error instanceof MissingLeafInputError) throw error;
      throw new WorkerFatalError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    sessions.set(key, session);
    log.info('session opened', message.run.id, node.adapter, node.actor);
  }
  const pending = session.tick(node, context);
  notifyReady();
  const result = await pending;
  if (!result || (result.status !== 'RUNNING' && result.status !== 'SUCCESS' && result.status !== 'FAILURE')) {
    throw new WorkerFatalError(`adapter ${manifest.id} returned invalid result status for ${node.capability}`);
  }
  if (result.output !== undefined && !isJsonValue(result.output)) {
    throw new WorkerFatalError(`adapter ${manifest.id} returned non-JSON output for ${node.capability}`);
  }
  return result;
}

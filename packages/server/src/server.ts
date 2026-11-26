import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdapterManifest } from '@tp/contract/adapter';
import {
  generateOpenApi,
  httpStatusForCode,
  matchOperation,
  paginate,
  type JsonObject,
  type PageQuery,
  type RunStatus,
} from '@tp/contract';
import { ZodError } from 'zod';

import { createAdapterRegistry, type AdapterRegistry } from './adapter-registry.ts';
import { loadAdapterModules, resolveAdapterModules } from './adapter-loader.ts';
import { errorResponse, HttpError } from './http-error.ts';
import { createPlatform } from './platform.ts';
import { createRunQueue } from './run-queue.ts';
import { logger } from './log.ts';
import { createServerMetrics, recordHttp, type ServerMetrics } from './metrics.ts';
import { createRunWatchHub, parseLastEventId, toSseRun, type RunWatchHub } from './sse.ts';
import { createWorkerPool, type WorkerPool } from './worker-pool.ts';
import { DEFAULT_SESSION_CLEANUP_TIMEOUT_MS } from './session-cleanup.ts';
import { DEFAULT_TREE_TICK_INTERVAL_MS } from './bt.ts';

const HOST_ROOT = process.env.TP_HOST_ROOT ?? fileURLToPath(new URL('../../..', import.meta.url));
const DEFAULT_PUBLIC_DIR = process.env.TP_PUBLIC_DIR ?? join(HOST_ROOT, 'dist', 'public');
const log = logger('server');
const httpLog = logger('http');
const MUTATING_OPERATIONS = new Set([
  'createCase',
  'updateCase',
  'deleteCase',
  'createGroup',
  'updateGroup',
  'deleteGroup',
  'createBatch',
  'importBatch',
  'cancelBatch',
  'cancelRun',
]);

type ServerOptions = {
  dataFile?: string;
  publicDir?: string;
  workerThreads?: number;
  sessionCleanupTimeoutMs?: number;
  treeTickIntervalMs?: number;
  runQueueCapacity?: number;
  runRetentionDays?: number;
  workspaceRoot?: string;
  adapterModules?: readonly string[];
  onWorkerFatal?: (error: Error) => void;
};

type Platform = Awaited<ReturnType<typeof createPlatform>>;

export async function createHttpServer(options: ServerOptions = {}): Promise<http.Server> {
  const runRetentionDays = options.runRetentionDays ?? Number(process.env.TP_RUN_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(runRetentionDays) || runRetentionDays < 1) {
    throw new Error('run retention days must be a positive integer');
  }
  const metrics = createServerMetrics();
  const registry = createAdapterRegistry();
  await loadAdapterModules(registry, resolveAdapterModules(options), metrics);
  const runQueue = createRunQueue({
    capacity: options.runQueueCapacity ?? Number(process.env.TP_RUN_QUEUE_CAPACITY ?? 1000),
    metrics,
  });
  const workspaceRoot = options.workspaceRoot ?? join(HOST_ROOT, 'data', 'runs');
  const platform = await createPlatform(options.dataFile, { registry, runQueue, metrics, workspaceRoot });
  let retentionCleanup = Promise.resolve();
  const pruneBatches = () => {
    retentionCleanup = platform.pruneBatches(Date.now() - runRetentionDays * 24 * 60 * 60 * 1000).then((count) => {
      if (count > 0) log.info('pruned expired batches', count);
    });
    return retentionCleanup;
  };
  await pruneBatches();
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const watches = createRunWatchHub();
  const originalApplyArtifact = runQueue.applyArtifact.bind(runQueue);
  runQueue.applyArtifact = (id, event) => {
    const next = originalApplyArtifact(id, event);
    watches.publish(next);
    return next;
  };
  const pool = createWorkerPool({
    size: options.workerThreads ?? Number(process.env.TP_WORKER_THREADS ?? 1),
    sessionCleanupTimeoutMs:
      options.sessionCleanupTimeoutMs ??
      Number(process.env.TP_SESSION_CLEANUP_TIMEOUT_MS ?? DEFAULT_SESSION_CLEANUP_TIMEOUT_MS),
    treeTickIntervalMs:
      options.treeTickIntervalMs ?? Number(process.env.TP_TREE_TICK_INTERVAL_MS ?? DEFAULT_TREE_TICK_INTERVAL_MS),
    registry,
    runQueue,
    workspaceRoot,
    onProgress: (runId, event) => {
      runQueue.recordProgress(runId, event);
      if (watches.hasSubscribers(runId)) watches.publish(runQueue.get(runId));
    },
    onResult: async (runId, result) => {
      watches.publish(await (await platform).finishRun(runId, result));
    },
    onRunFatal: async (runId, result) => {
      watches.publish(await (await platform).finishRun(runId, result));
    },
    onFatal:
      options.onWorkerFatal ??
      ((error) => {
        log.error('worker fatal', error);
        process.exit(1);
      }),
    metrics,
  });
  pool.start();
  const retentionTimer = setInterval(
    () => {
      void pruneBatches().catch((error: unknown) => log.error('run retention cleanup failed', error));
    },
    60 * 60 * 1000,
  ).unref();

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    try {
      if (req.url?.startsWith('/api/')) {
        await handleApi(await platform, registry, pool, metrics, watches, started, req, res);
        return;
      }
      if (serveDocs(req, res)) return;
      await serveStatic(publicDir, req, res);
    } catch (error) {
      sendError(res, error, req, metrics, started);
    }
  });
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      log.info('listening', `http://${address.address}:${address.port}`);
    }
  });
  const closeHttp = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    clearInterval(retentionTimer);
    server.closeAllConnections();
    closeHttp((error) => {
      void pool
        .close()
        .then(() => retentionCleanup)
        .then(
          () => callback?.(error),
          (poolError: unknown) => callback?.(poolError instanceof Error ? poolError : new Error(String(poolError))),
        );
    });
    return server;
  }) as http.Server['close'];
  return server;
}

async function handleApi(
  platform: Platform,
  registry: AdapterRegistry,
  pool: WorkerPool,
  metrics: ServerMetrics,
  watches: RunWatchHub,
  started: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const op = matchOperation(req.method ?? '', url.pathname);
  if (!op) throw new HttpError('not_found', 'not found');
  if (op.id === 'watchRun') {
    let lastEventId: number | undefined;
    try {
      lastEventId = parseLastEventId(req.headers['last-event-id']);
    } catch {
      throw new HttpError('invalid', 'Last-Event-ID must be a non-negative integer');
    }
    const run = await platform.getRun(op.params.id ?? '');
    const snapshot = toSseRun(run);
    if (!snapshot) throw new HttpError('invalid', `run ${op.params.id} is not a public Run`);
    logHttpSuccess(req, op.id, op.successStatus);
    recordHttp(metrics, op.id, op.successStatus, started);
    watches.subscribe(snapshot, req, res, lastEventId);
    return;
  }
  const query = parseQuery(op.id, op.query, url.searchParams);
  const body = op.body ? op.body.parse(await readJson(req)) : null;
  const result = await dispatch(op.id, {
    params: op.params,
    query,
    body,
    platform,
    registry,
    pool,
    metrics,
    watches,
  });
  if (op.id === 'getRunArtifact') {
    const payload = result as { bytes: Buffer; name: string; mediaType: string };
    logHttpSuccess(req, op.id, op.successStatus);
    recordHttp(metrics, op.id, op.successStatus, started);
    res.writeHead(op.successStatus, {
      'content-type': payload.mediaType,
      'content-disposition': artifactContentDisposition(payload.name, payload.mediaType),
    });
    res.end(payload.bytes);
    return;
  }
  if (op.successStatus === 204) {
    logHttpSuccess(req, op.id, 204);
    recordHttp(metrics, op.id, 204, started);
    res.writeHead(204);
    res.end();
    return;
  }
  if (!op.response) throw new Error(`operation ${op.id} is missing a response schema`);
  logHttpSuccess(req, op.id, op.successStatus);
  recordHttp(metrics, op.id, op.successStatus, started);
  sendJson(res, op.successStatus, op.response.parse(result));
}

async function dispatch(
  id: string,
  context: {
    params: Record<string, string>;
    query: unknown;
    body: unknown;
    platform: Platform;
    registry: AdapterRegistry;
    pool: WorkerPool;
    metrics: ServerMetrics;
    watches: RunWatchHub;
  },
): Promise<unknown> {
  const { params, query, body, platform, registry, pool, metrics, watches } = context;
  const page = query as PageQuery;
  switch (id) {
    case 'listAdapters':
      return paginate(registry.listAdapters().map(toHttpAdapter), page);
    case 'getAdapter':
      return toHttpAdapter(getRegisteredAdapter(registry, params.id ?? ''));
    case 'listCases':
      return paginate(await platform.listCases(), page);
    case 'createCase':
      return platform.createCase(body);
    case 'getCase':
      return platform.getCase(params.id ?? '');
    case 'updateCase':
      return platform.updateCase(params.id ?? '', body);
    case 'deleteCase':
      return platform.deleteCase(params.id ?? '');
    case 'listGroups':
      return paginate(await platform.listGroups(), page);
    case 'getGroup':
      return platform.getGroup(params.id ?? '');
    case 'createGroup':
      return platform.createGroup(body);
    case 'updateGroup':
      return platform.updateGroup(params.id ?? '', body);
    case 'deleteGroup':
      return platform.deleteGroup(params.id ?? '');
    case 'listRuns':
      return platform.listRuns(query as PageQuery & { status?: RunStatus[] });
    case 'listBatches':
      return platform.listBatches(page);
    case 'getBatch':
      return platform.getBatch(params.id ?? '');
    case 'createBatch':
      return platform.createBatch(body);
    case 'importBatch':
      return platform.importBatch(body);
    case 'cancelBatch': {
      return platform.cancelBatch(params.id ?? '', (run) => {
        const snapshot = toSseRun(run);
        if (snapshot) watches.publish(snapshot);
        if (run.status === 'canceling') pool.cancel(run.id);
      });
    }
    case 'getRunArtifact':
      return platform.getRunArtifact(params.id ?? '', params.artifactId ?? '');
    case 'cancelRun': {
      const run = await platform.cancelRun(params.id ?? '');
      watches.publish(run);
      if (run.status === 'canceling') pool.cancel(run.id);
      return run;
    }
    case 'listWorkers':
      return paginate(pool.list(), page);
    case 'getWorker': {
      const worker = pool.list().find((item) => item.id === params.id);
      if (!worker) throw new HttpError('not_found', `worker ${params.id} not found`);
      return worker;
    }
    case 'getMetrics':
      return { instruments: metrics.collect() };
    default:
      throw new HttpError('not_found', 'not found');
  }
}

function parseQuery(
  operationId: string,
  schema: { parse(value: unknown): unknown },
  searchParams: URLSearchParams,
): unknown {
  const raw: Record<string, unknown> = Object.fromEntries(searchParams);
  if (operationId === 'listRuns') {
    delete raw.status;
    const status = searchParams.getAll('status');
    if (status.length > 0) raw.status = status;
  }
  return schema.parse(raw);
}

function getRegisteredAdapter(registry: AdapterRegistry, id: string): AdapterManifest {
  try {
    return registry.getAdapter(id);
  } catch {
    throw new HttpError('not_found', `adapter ${id} not found`);
  }
}

function toHttpAdapter(manifest: AdapterManifest) {
  return {
    id: manifest.id,
    capabilities: manifest.capabilities.map((capability) => ({
      key: capability.key,
      kind: capability.kind,
      label: capability.label,
      ports: capability.ports,
      adapter: manifest.id,
    })),
    session: manifest.session ?? { ports: [] },
  };
}

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>TP HTTP API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>
`;

function serveDocs(req: IncomingMessage, res: ServerResponse): boolean {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/openapi.json') {
    sendJson(res, 200, generateOpenApi());
    return true;
  }
  if (pathname === '/swagger' || pathname === '/swagger/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SWAGGER_HTML);
    return true;
  }
  return false;
}

async function serveStatic(publicDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = staticPath(url.pathname);
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, relative);

  const file = await stat(filePath).catch(() => null);
  if (!file?.isFile()) {
    sendJson(res, httpStatusForCode('not_found'), { code: 'not_found', message: 'not found' });
    return;
  }

  res.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

function staticPath(pathname: string): string {
  if (pathname === '/') return '/index.html';
  if (pathname.endsWith('/')) return `${pathname}index.html`;
  return pathname;
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as JsonObject) : {});
      } catch {
        reject(new HttpError('invalid', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
}

function logHttpSuccess(req: IncomingMessage, operationId: string, status: number): void {
  const line = [req.method ?? '', req.url ?? '', status, operationId] as const;
  if (MUTATING_OPERATIONS.has(operationId)) httpLog.info(...line);
  else httpLog.debug(...line);
}

function sendError(
  res: ServerResponse,
  error: unknown,
  req: IncomingMessage,
  metrics?: ServerMetrics,
  started?: number,
): void {
  const method = req.method ?? '';
  const path = req.url ?? '';
  const { status, body } = errorResponse(error);
  if (error instanceof HttpError || error instanceof ZodError) {
    httpLog.warn(method, path, body.code, body.message);
  } else {
    httpLog.error(method, path, status, body.message);
  }
  if (metrics && started !== undefined && path.startsWith('/api/')) {
    const pathname = new URL(path, 'http://localhost').pathname;
    const op = matchOperation(method, pathname);
    recordHttp(metrics, op?.id ?? 'unknown', status, started);
  }
  sendJson(res, status, body);
}

function artifactContentDisposition(name: string, mediaType: string): string {
  const ext =
    {
      'text/plain': '.txt',
      'video/mp4': '.mp4',
      'image/png': '.png',
      'image/jpeg': '.jpg',
    }[mediaType] ?? '';
  const base = name.trim() || 'artifact';
  const filename = ext && !base.toLowerCase().endsWith(ext) ? `${base}${ext}` : base;
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'artifact';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function contentType(filePath: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[extname(filePath)] ?? 'application/octet-stream'
  );
}

export function httpListenAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port } = httpListenAddress();
  const server = await createHttpServer({ dataFile: process.env.TP_DATA_FILE });
  server.listen(port, host);
}

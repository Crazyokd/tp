import {
  adapterPath,
  apiErrorSchema,
  apiPaths,
  casePath,
  groupPath,
  httpGroupWriteSchema,
  httpAdapterSchema,
  httpCaseSchema,
  httpCaseWriteSchema,
  httpBatchCreateSchema,
  httpBatchImportSchema,
  batchPath,
  batchCancelPath,
  type Batch,
  httpRunSchema,
  httpWorkerSchema,
  operations,
  runArtifactPath,
  runCancelPath,
  runEventsPath,
  workerPath,
  type HttpOperation,
  type Run,
  type RunStatus,
  type TestCase,
  type TestGroup,
} from '@tp/contract';
import type { z } from 'zod';

type Page<T> = { items: T[]; total: number };
export type HttpAdapter = z.infer<typeof httpAdapterSchema>;
type HttpCase = z.infer<typeof httpCaseSchema>;
type HttpRun = z.infer<typeof httpRunSchema>;
type HttpWorker = z.infer<typeof httpWorkerSchema>;

type PageQuery = {
  limit?: number;
  offset?: number;
};

function operation(id: string): HttpOperation {
  const found = operations.find((item) => item.id === id);
  if (!found) throw new Error(`unknown HTTP operation ${id}`);
  return found;
}

function withPage(url: URL, query?: PageQuery): void {
  if (query?.limit === undefined && query?.offset === undefined) return;
  if (query.limit === undefined || query.offset === undefined) {
    throw new Error('limit and offset must both be provided or both omitted');
  }
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('offset', String(query.offset));
}

function requestUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}

async function parseResponse<T>(op: HttpOperation, response: Response): Promise<T> {
  if (!response.ok) {
    const error = apiErrorSchema.parse(await response.json());
    throw new Error(error.message);
  }
  if (op.successStatus === 204 || response.status === 204) return undefined as T;
  if (!op.response) throw new Error(`operation ${op.id} is missing a response schema`);
  return op.response.parse(await response.json()) as T;
}

async function send(op: HttpOperation, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  });
}

export async function listAdapters(query?: PageQuery): Promise<Page<HttpAdapter>> {
  const url = new URL(apiPaths.adapters, window.location.origin);
  withPage(url, query);
  return parseResponse(operation('listAdapters'), await send(operation('listAdapters'), requestUrl(url)));
}

export async function getAdapter(id: string): Promise<HttpAdapter> {
  return parseResponse(operation('getAdapter'), await send(operation('getAdapter'), adapterPath(id)));
}

export async function listCases(query?: PageQuery): Promise<Page<HttpCase>> {
  const url = new URL(apiPaths.cases, window.location.origin);
  withPage(url, query);
  return parseResponse(operation('listCases'), await send(operation('listCases'), requestUrl(url)));
}

export async function createCase(body: unknown): Promise<HttpCase> {
  return parseResponse(
    operation('createCase'),
    await send(operation('createCase'), apiPaths.cases, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpCaseWriteSchema.parse(body)),
    }),
  );
}

export async function getCase(id: string): Promise<HttpCase> {
  return parseResponse(operation('getCase'), await send(operation('getCase'), casePath(id)));
}

export async function updateCase(id: string, body: unknown): Promise<HttpCase> {
  return parseResponse(
    operation('updateCase'),
    await send(operation('updateCase'), casePath(id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpCaseWriteSchema.parse(body)),
    }),
  );
}

export async function deleteCase(id: string): Promise<void> {
  await parseResponse(operation('deleteCase'), await send(operation('deleteCase'), casePath(id), { method: 'DELETE' }));
}

export async function listGroups(): Promise<Page<TestGroup>> {
  return parseResponse(operation('listGroups'), await send(operation('listGroups'), apiPaths.groups));
}

export async function createGroup(body: unknown): Promise<TestGroup> {
  return parseResponse(
    operation('createGroup'),
    await send(operation('createGroup'), apiPaths.groups, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpGroupWriteSchema.parse(body)),
    }),
  );
}

export async function updateGroup(id: string, body: unknown): Promise<TestGroup> {
  return parseResponse(
    operation('updateGroup'),
    await send(operation('updateGroup'), groupPath(id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpGroupWriteSchema.parse(body)),
    }),
  );
}

export async function deleteGroup(id: string): Promise<void> {
  await parseResponse(
    operation('deleteGroup'),
    await send(operation('deleteGroup'), groupPath(id), { method: 'DELETE' }),
  );
}

export async function listRuns(query?: PageQuery & { status?: RunStatus[] }): Promise<Page<HttpRun>> {
  const url = new URL(apiPaths.runs, window.location.origin);
  for (const status of query?.status ?? []) url.searchParams.append('status', status);
  withPage(url, query);
  return parseResponse(operation('listRuns'), await send(operation('listRuns'), requestUrl(url)));
}

export async function listBatches(query?: PageQuery): Promise<Page<Batch>> {
  const url = new URL(apiPaths.batches, window.location.origin);
  withPage(url, query);
  return parseResponse(operation('listBatches'), await send(operation('listBatches'), requestUrl(url)));
}

export async function getBatch(id: string): Promise<Batch> {
  return parseResponse(operation('getBatch'), await send(operation('getBatch'), batchPath(id)));
}

export async function createBatch(body: unknown): Promise<Batch> {
  return parseResponse(
    operation('createBatch'),
    await send(operation('createBatch'), apiPaths.batches, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpBatchCreateSchema.parse(body)),
    }),
  );
}

export async function importBatch(body: unknown): Promise<Batch> {
  return parseResponse(
    operation('importBatch'),
    await send(operation('importBatch'), `${apiPaths.batches}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpBatchImportSchema.parse(body)),
    }),
  );
}

export async function cancelBatch(id: string): Promise<Batch> {
  return parseResponse(
    operation('cancelBatch'),
    await send(operation('cancelBatch'), batchCancelPath(id), { method: 'POST' }),
  );
}

export async function cancelRun(id: string): Promise<HttpRun> {
  return parseResponse(
    operation('cancelRun'),
    await send(operation('cancelRun'), runCancelPath(id), { method: 'POST' }),
  );
}

export async function listWorkers(query?: PageQuery): Promise<Page<HttpWorker>> {
  const url = new URL(apiPaths.workers, window.location.origin);
  withPage(url, query);
  return parseResponse(operation('listWorkers'), await send(operation('listWorkers'), requestUrl(url)));
}

export async function getWorker(id: string): Promise<HttpWorker> {
  return parseResponse(operation('getWorker'), await send(operation('getWorker'), workerPath(id)));
}

export { runArtifactPath, runEventsPath };
export type { Run, TestCase };

import {
  apiErrorSchema,
  httpRunSchema,
  operations,
  runEventsPath,
  type ApiErrorCode,
  type HttpOperation,
} from '@tp/contract';

export class TpApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TpApiError';
  }
}

export type InvokeInput = {
  params?: Record<string, string>;
  query?: unknown;
  body?: unknown;
};

export type WatchRunOptions = {
  signal?: AbortSignal;
  lastEventId?: string;
};

export type TpClient = {
  invoke(id: string, input?: InvokeInput): Promise<unknown>;
  watchRun(id: string, options?: WatchRunOptions): AsyncIterable<unknown>;
};

export type TpClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export function createTpClient(options: TpClientOptions): TpClient {
  const request = options.fetch ?? fetch;
  return {
    invoke(id, input = {}) {
      return invokeOperation(options.baseUrl, request, id, input);
    },
    watchRun(id, watch = {}) {
      return watchRunOperation(options.baseUrl, request, id, watch);
    },
  };
}

async function* watchRunOperation(
  baseUrl: string,
  request: typeof fetch,
  id: string,
  options: WatchRunOptions,
): AsyncGenerator<unknown> {
  const operation = operations.find((item) => item.id === 'watchRun');
  if (!operation) throw new Error('unknown HTTP operation watchRun');
  const url = new URL(runEventsPath(id), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  let response: Response;
  try {
    response = await request(url, {
      method: operation.method,
      headers: {
        accept: 'text/event-stream',
        ...(options.lastEventId === undefined ? {} : { 'Last-Event-ID': options.lastEventId }),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
  if (!response.ok) {
    const error = apiErrorSchema.parse(await response.json());
    throw new TpApiError(error.code, error.message);
  }
  if (!response.body) throw new Error('watchRun response is missing a body');
  yield* readSseRuns(response.body, options.signal);
}

async function* readSseRuns(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseBlock(block);
        if (event?.name === 'run' && event.data !== undefined) {
          yield httpRunSchema.parse(JSON.parse(event.data));
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { name: string; data?: string } | undefined {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  return { name, data: data.join('\n') };
}

function operation(id: string): HttpOperation {
  const found = operations.find((item) => item.id === id);
  if (!found) throw new Error(`unknown HTTP operation ${id}`);
  return found;
}

function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`missing path param ${name}`);
    return encodeURIComponent(value);
  });
}

function applyQuery(url: URL, query: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

async function invokeOperation(
  baseUrl: string,
  request: typeof fetch,
  id: string,
  input: InvokeInput,
): Promise<unknown> {
  const op = operation(id);
  const params = input.params ?? {};
  const query = op.query.parse(input.query ?? {});
  const body = op.body ? op.body.parse(input.body) : undefined;
  const url = new URL(fillPath(op.path, params), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  applyQuery(url, query as Record<string, unknown>);

  let response: Response;
  try {
    response = await request(url, {
      method: op.method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }

  if (!response.ok) {
    const error = apiErrorSchema.parse(await response.json());
    throw new TpApiError(error.code, error.message);
  }
  if (op.successStatus === 204 || response.status === 204) return undefined;
  if (!op.response) throw new Error(`operation ${op.id} is missing a response schema`);
  return op.response.parse(await response.json());
}

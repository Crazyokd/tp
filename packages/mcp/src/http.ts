import { apiErrorSchema, operations, type ApiErrorCode, type HttpOperation } from '@tp/contract';

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

export type TpClient = {
  invoke(id: string, input?: InvokeInput): Promise<unknown>;
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
  };
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

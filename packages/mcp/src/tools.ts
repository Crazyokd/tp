import { httpCaseWriteSchema, operations, type HttpOperation } from '@tp/contract';
import { z } from 'zod';

import type { TpClient } from './http.ts';
import { createCaseAndRun, waitForRun, waitForRunInputSchema } from './workflows.ts';

export const CONTRACT_TOOL_IDS = [
  'listAdapters',
  'getAdapter',
  'listCases',
  'createCase',
  'getCase',
  'updateCase',
  'deleteCase',
  'listRuns',
  'createRun',
  'getRun',
  'cancelRun',
] as const;

export type ContractToolId = (typeof CONTRACT_TOOL_IDS)[number];

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  execute: (input: unknown) => Promise<unknown>;
};

export function contractOperation(id: ContractToolId): HttpOperation {
  const found = operations.find((item) => item.id === id);
  if (!found) throw new Error(`unknown HTTP operation ${id}`);
  return found;
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
}

function objectShape(schema: z.ZodType): z.ZodRawShape {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('tool input query/body must be a ZodObject');
  }
  return schema.shape;
}

export function toolInputSchema(op: HttpOperation): z.ZodObject {
  const pathShape = Object.fromEntries(pathParamNames(op.path).map((name) => [name, z.string().trim().min(1)]));
  return z.object({ ...pathShape, ...objectShape(op.body ?? op.query) });
}

export async function invokeFromToolInput(client: TpClient, id: ContractToolId, input: unknown): Promise<unknown> {
  const op = contractOperation(id);
  const raw = z.record(z.string(), z.unknown()).parse(input ?? {});
  const params: Record<string, string> = {};
  const rest: Record<string, unknown> = { ...raw };
  for (const name of pathParamNames(op.path)) {
    const value = rest[name];
    delete rest[name];
    params[name] = z.string().trim().min(1).parse(value);
  }
  const query = op.query.parse(op.body ? {} : rest);
  const body = op.body ? op.body.parse(rest) : undefined;
  return client.invoke(op.id, { params, query, body });
}

export function createTools(client: TpClient): ToolDescriptor[] {
  const contractTools: ToolDescriptor[] = CONTRACT_TOOL_IDS.map((id) => {
    const op = contractOperation(id);
    return {
      name: id,
      description: `${op.method} ${op.path}`,
      inputSchema: toolInputSchema(op),
      execute: (input) => invokeFromToolInput(client, id, input),
    };
  });
  return [
    ...contractTools,
    {
      name: 'createCaseAndRun',
      description: 'Create a Case then enqueue a Run. Does not roll back the Case if createRun fails.',
      inputSchema: httpCaseWriteSchema,
      execute: (input) => createCaseAndRun(client, input),
    },
    {
      name: 'waitForRun',
      description: 'Poll getRun until passed, failed, or canceled.',
      inputSchema: waitForRunInputSchema,
      execute: (input) => waitForRun(client, input),
    },
  ];
}

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
  'listGroups',
  'createGroup',
  'getGroup',
  'updateGroup',
  'deleteGroup',
  'listBatches',
  'getBatch',
  'createBatch',
  'cancelBatch',
  'listRuns',
  'cancelRun',
] as const;

export type ContractToolId = (typeof CONTRACT_TOOL_IDS)[number];

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  execute: (input: unknown) => Promise<unknown>;
};

const TOOL_DESCRIPTIONS = {
  listAdapters:
    'GET /api/adapters. List registered adapters and their capability catalog. Call this before writing leaves.',
  getAdapter:
    'GET /api/adapters/:id. One adapter: capability ports and session ports. Use these names only; do not invent ports.',
  listCases: 'GET /api/cases. Existing cases. Call this before createBatch. Prefer an existing case over createCase.',
  createCase:
    'POST /api/cases. Body: name + definition. definition.sessions must match every leaf (adapter, actor). Invalid document or catalog fails. Does not start a run.',
  getCase: 'GET /api/cases/:id. Full case including definition.trees and definition.sessions.',
  updateCase:
    'PUT /api/cases/:id. Replace name, description and definition. Fails while a live run exists for this case. 400 on invalid catalog or sessions. Do not invent capabilities.',
  deleteCase: 'DELETE /api/cases/:id. Fails while a live run or Group reference exists for this case.',
  listGroups:
    'GET /api/groups. Independent test groups referencing existing Case ids. Select a group before creating a batch.',
  createGroup:
    'POST /api/groups. Body: name + caseIds. Case ids must exist and be unique. Does not copy Cases or start Runs.',
  getGroup: 'GET /api/groups/:id. Returns a group and its referenced Case ids. One Case can belong to multiple groups.',
  updateGroup:
    'PUT /api/groups/:id. Replace name and caseIds. Membership changes apply to future batches, not queued Runs.',
  deleteGroup: 'DELETE /api/groups/:id. Removes the group. Referenced Cases and existing Runs are retained.',
  listRuns: 'GET /api/runs. Page of runs with status (queued, running, passed, failed, canceled).',
  listBatches: 'GET /api/batches. Page of batches with aggregate status, Run status counts and member runs.',
  getBatch: 'GET /api/batches/:id. One batch including its status, counts and fixed member runs.',
  createBatch:
    'POST /api/batches. Body selects exactly one of { caseIds: [id, ...] } or { groupId }, with required trigger: { kind: web | mcp | ci }; ci optionally includes an HTTP(S) pipelineUrl. Trigger is declared provenance, not authenticated identity. Optional name, description and blackboard; omitted name is generated; omitted description is empty. Selection metadata is Server-owned. Case ids must be nonempty and unique. Returns one Batch with fixed member runs and snapshots of current definitions. Blackboard keys are written before the session opens. Server and adapters must already be running. Does not deploy.',
  cancelBatch:
    'POST /api/batches/:id/cancel. Halt all active member trees and recycle their workers and sessions. Returns the Batch.',
  cancelRun: 'POST /api/runs/:id/cancel. Halt the tree and recycle the worker and session.',
  createCaseAndRun:
    'Create a Case then call createBatch with caseIds: [case.id] and trigger: { kind: mcp }, using the Server-generated Batch name and empty description. Returns { case, batch }; use batch.runs with waitForRun. Does not roll back the Case if createBatch fails; the error includes the created case.id.',
  waitForRun:
    'Watch a Run over SSE until passed, failed, or canceled. timeoutMs is required (use minutes for long cases, not seconds). canceled is a successful wait. Does not register a streaming MCP tool.',
} as const satisfies Record<ContractToolId | 'createCaseAndRun' | 'waitForRun', string>;

export function contractOperation(id: ContractToolId): HttpOperation {
  const found = operations.find((item) => item.id === id);
  if (!found) throw new Error(`unknown HTTP operation ${id}`);
  return found;
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
}

export function toolInputSchema(op: HttpOperation): z.ZodObject {
  const pathShape = Object.fromEntries(pathParamNames(op.path).map((name) => [name, z.string().trim().min(1)]));
  const schema = op.body ?? op.query;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('tool input query/body must be a ZodObject');
  }
  return schema.safeExtend(pathShape);
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
      description: TOOL_DESCRIPTIONS[id],
      inputSchema: toolInputSchema(op),
      execute: (input) => invokeFromToolInput(client, id, input),
    };
  });
  return [
    ...contractTools,
    {
      name: 'createCaseAndRun',
      description: TOOL_DESCRIPTIONS.createCaseAndRun,
      inputSchema: httpCaseWriteSchema,
      execute: (input) => createCaseAndRun(client, input),
    },
    {
      name: 'waitForRun',
      description: TOOL_DESCRIPTIONS.waitForRun,
      inputSchema: waitForRunInputSchema,
      execute: (input) => waitForRun(client, input),
    },
  ];
}

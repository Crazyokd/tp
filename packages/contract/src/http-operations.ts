import { z } from 'zod';

import { leafNodeTypes, type RunNode } from './types.ts';
import { portDefinitionSchema } from './adapter-contract.ts';
import { caseDocumentSchema } from './case-document.ts';
import { apiPaths } from './http.ts';
import { pageQuerySchema, pageSchema } from './http-page.ts';
import { isJsonValue } from './json-value.ts';
import { assertPreconditionSyntax } from './precondition.ts';

const emptyQuerySchema = z.object({}).strict();

const catalogCapabilitySchema = z
  .object({
    key: z.string().trim().min(1),
    kind: z.enum(leafNodeTypes),
    label: z.string().trim().min(1),
    ports: z.array(portDefinitionSchema),
    adapter: z.string().trim().min(1),
  })
  .strict();

export const httpAdapterSchema = z
  .object({
    id: z.string().trim().min(1),
    capabilities: z.array(catalogCapabilitySchema),
    session: z
      .object({ ports: z.array(portDefinitionSchema) })
      .strict()
      .optional(),
  })
  .strict();

const caseDefinitionSchema = caseDocumentSchema;

export const httpCaseWriteSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    definition: caseDefinitionSchema,
  })
  .strict();

export const httpCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    definition: caseDefinitionSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const httpGroupWriteSchema = z
  .object({
    name: z.string().trim().min(1),
    caseIds: z.array(z.string().trim().min(1)).refine((ids) => new Set(ids).size === ids.length, {
      message: 'duplicate case ids',
    }),
  })
  .strict();

export const httpGroupSchema = httpGroupWriteSchema.extend({
  id: z.string().trim().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const httpRunStatusSchema = z.enum(['queued', 'running', 'canceling', 'passed', 'failed', 'canceled']);

const runNodeAttemptSchema = z
  .object({
    attempt: z.number().int(),
    status: z.enum(['running', 'passed', 'failed', 'canceled', 'skipped']),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    output: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  })
  .strict();

const threshold = z
  .number()
  .int()
  .refine((n) => n === -1 || n >= 1);
const attempts = threshold;
const precondition = z.string().superRefine((value, ctx) => {
  try {
    assertPreconditionSyntax(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid precondition' });
  }
});
const preconditions = {
  _skipIf: precondition.optional(),
  _successIf: precondition.optional(),
  _failureIf: precondition.optional(),
};
const recordKey = z
  .string()
  .min(1)
  .refine((key) => key === key.trim(), {
    message: 'padded keys are illegal',
  });
const portBinding = z.union([
  z.object({ literal: z.unknown() }).strict(),
  z.object({ key: z.string().trim().min(1) }).strict(),
]);
const portBindings = z.record(recordKey, portBinding);
const remap = z.record(recordKey, z.object({ key: z.string().trim().min(1) }).strict());

const runNodeStateSchema = {
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'canceled']),
  attempts: z.array(runNodeAttemptSchema),
};

const runNodeSchema: z.ZodType<RunNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('Sequence'),
        children: z.array(runNodeSchema).min(1),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('ReactiveSequence'),
        children: z.array(runNodeSchema).min(1),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Fallback'),
        children: z.array(runNodeSchema).min(1),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('ReactiveFallback'),
        children: z.array(runNodeSchema).min(1),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Parallel'),
        children: z.array(runNodeSchema).min(1),
        success_count: threshold.optional(),
        failure_count: threshold.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('ParallelAll'),
        children: z.array(runNodeSchema).min(1),
        max_failures: threshold.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('RetryUntilSuccessful'),
        num_attempts: attempts,
        child: runNodeSchema,
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Repeat'),
        num_cycles: attempts,
        child: runNodeSchema,
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Timeout'),
        msec: z.number().int().positive(),
        child: runNodeSchema,
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Delay'),
        msec: z.number().int().positive(),
        child: runNodeSchema,
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z.object({ type: z.literal('Inverter'), child: runNodeSchema, ...preconditions, ...runNodeStateSchema }).strict(),
    z
      .object({ type: z.literal('ForceSuccess'), child: runNodeSchema, ...preconditions, ...runNodeStateSchema })
      .strict(),
    z
      .object({ type: z.literal('ForceFailure'), child: runNodeSchema, ...preconditions, ...runNodeStateSchema })
      .strict(),
    z
      .object({
        type: z.literal('KeepRunningUntilFailure'),
        child: runNodeSchema,
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z.object({ type: z.literal('RunOnce'), child: runNodeSchema, ...preconditions, ...runNodeStateSchema }).strict(),
    z
      .object({
        type: z.literal('IfThenElse'),
        if: runNodeSchema,
        then: runNodeSchema,
        else: runNodeSchema.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('WhileDoElse'),
        if: runNodeSchema,
        then: runNodeSchema,
        else: runNodeSchema.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Switch'),
        variable: z.string().trim().min(1),
        cases: z.array(z.string()),
        children: z.array(runNodeSchema),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict()
      .refine((node) => node.children.length === node.cases.length + 1, {
        message: 'Switch children must include a default',
        path: ['children'],
      }),
    z
      .object({
        type: z.literal('SubTree'),
        id: z.string().trim().min(1),
        remap: remap.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Action'),
        adapter: z.string().trim().min(1),
        actor: z.string().trim().min(1),
        capability: z.string().trim().min(1),
        ports: portBindings.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('Condition'),
        adapter: z.string().trim().min(1),
        actor: z.string().trim().min(1),
        capability: z.string().trim().min(1),
        ports: portBindings.optional(),
        ...preconditions,
        ...runNodeStateSchema,
      })
      .strict(),
  ]),
);

const runTreeSchema = z
  .object({
    main: z.string().trim().min(1),
    trees: z.record(z.string(), runNodeSchema),
  })
  .strict();

export const httpRunSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .refine((id) => id !== '.' && id !== '..' && !/[/\\\0]/.test(id), {
        message: 'invalid run resource root',
      }),
    batchId: z.string().trim().min(1),
    caseId: z.string().trim().min(1),
    status: httpRunStatusSchema,
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    tree: runTreeSchema,
    artifacts: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          name: z.string().trim().min(1),
          mediaType: z.string().trim().min(1),
        })
        .strict(),
    ),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const live = run.status === 'queued' || run.status === 'running' || run.status === 'canceling';
    if (live && run.finishedAt !== null) {
      ctx.addIssue({ code: 'custom', message: 'live run cannot have finishedAt' });
    }
    if (!live && run.finishedAt === null) {
      ctx.addIssue({ code: 'custom', message: 'terminal run requires finishedAt' });
    }
    if (run.status === 'queued' && run.startedAt !== null) {
      ctx.addIssue({ code: 'custom', message: 'queued run cannot have startedAt' });
    }
    if (run.status === 'failed') {
      if (typeof run.error !== 'string' || run.error.trim() === '') {
        ctx.addIssue({ code: 'custom', message: 'failed run requires a terminal error' });
      }
    } else if (run.error !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'error is only allowed on failed runs' });
    }
  });

const blackboardKey = z
  .string()
  .min(1)
  .refine((key) => key === key.trim(), { message: 'padded keys are illegal' });

export const httpBatchTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('web') }).strict(),
  z.object({ kind: z.literal('mcp') }).strict(),
  z
    .object({
      kind: z.literal('ci'),
      pipelineUrl: z
        .string()
        .trim()
        .url()
        .regex(/^https?:\/\//)
        .optional(),
    })
    .strict(),
]);

export const httpBatchSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cases') }).strict(),
  z
    .object({ kind: z.literal('group'), groupId: z.string().trim().min(1), groupName: z.string().trim().min(1) })
    .strict(),
]);

export const httpBatchMetadataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string(),
    trigger: httpBatchTriggerSchema,
    selection: httpBatchSelectionSchema,
  })
  .strict();

export const httpBatchSchema = httpBatchMetadataSchema
  .extend({
    id: z.string().trim().min(1),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    status: z.enum(['queued', 'running', 'passed', 'failed', 'canceled']),
    counts: z
      .object({
        queued: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        canceling: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        canceled: z.number().int().nonnegative(),
      })
      .strict(),
    runs: z.array(httpRunSchema).min(1),
  })
  .strict();

export const httpBatchCreateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    trigger: httpBatchTriggerSchema,
    caseIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'duplicate case ids',
      })
      .meta({ uniqueItems: true })
      .optional(),
    groupId: z.string().trim().min(1).optional(),
    blackboard: z.record(blackboardKey, z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.caseIds === undefined) === (body.groupId === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of caseIds or groupId' });
    }
    for (const [key, value] of Object.entries(body.blackboard ?? {})) {
      if (!isJsonValue(value)) ctx.addIssue({ code: 'custom', message: `blackboard ${key} is not JSON` });
    }
  })
  .meta({ oneOf: [{ required: ['caseIds'] }, { required: ['groupId'] }] });

const httpRunImportFileSchema = z
  .object({
    runId: z.string().trim().min(1),
    artifactId: z.string().trim().min(1),
    path: z.string().trim().min(1),
    contentBase64: z.string(),
  })
  .strict();

export const httpBatchImportSchema = httpBatchMetadataSchema
  .extend({
    runs: z.array(httpRunSchema).min(1),
    files: z.array(httpRunImportFileSchema),
  })
  .strict()
  .superRefine((body, ctx) => {
    const batchId = body.runs[0]?.batchId;
    if (body.runs.some((run) => run.batchId !== batchId)) {
      ctx.addIssue({ code: 'custom', message: 'imported runs must share one batchId' });
    }
    const runIds = new Set<string>();
    for (const run of body.runs) {
      if (run.status === 'queued' || run.status === 'running' || run.status === 'canceling') {
        ctx.addIssue({ code: 'custom', message: 'imported runs must be terminal' });
      }
      if (runIds.has(run.id)) ctx.addIssue({ code: 'custom', message: `duplicate run id ${run.id}` });
      runIds.add(run.id);
      const artifactIds = new Set<string>();
      for (const artifact of run.artifacts) {
        if (artifactIds.has(artifact.id)) {
          ctx.addIssue({ code: 'custom', message: `duplicate artifact id ${artifact.id}` });
        }
        artifactIds.add(artifact.id);
      }
    }
    const expected = body.runs.flatMap((run) => run.artifacts.map((artifact) => `${run.id}\0${artifact.id}`));
    const actual = body.files.map((file) => `${file.runId}\0${file.artifactId}`);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    if (
      expected.length !== expectedSet.size ||
      actual.length !== actualSet.size ||
      expectedSet.size !== actualSet.size
    ) {
      ctx.addIssue({ code: 'custom', message: 'artifact files must match run artifacts' });
      return;
    }
    for (const key of expectedSet) {
      if (!actualSet.has(key)) ctx.addIssue({ code: 'custom', message: 'artifact files must match run artifacts' });
    }
    for (const run of body.runs) {
      const paths = body.files.filter((file) => file.runId === run.id).map((file) => file.path);
      if (new Set(paths).size !== paths.length) {
        ctx.addIssue({ code: 'custom', message: `duplicate artifact path on run ${run.id}` });
      }
    }
  });

// Server reads repeatable `status` via URLSearchParams.getAll('status').
export const listRunsQuerySchema = pageQuerySchema.extend({
  status: z.array(httpRunStatusSchema).optional(),
});

export const httpWorkerSchema = z
  .object({
    id: z.string().trim().min(1),
    state: z.enum(['starting', 'idle', 'running', 'finalizing', 'failed']),
    runId: z.string().nullable(),
  })
  .strict();

const metricsLabelsSchema = z.record(z.string(), z.string());

const metricsCounterGaugeSchema = z
  .object({
    kind: z.enum(['counter', 'gauge']),
    name: z.string().trim().min(1),
    help: z.string().trim().min(1).optional(),
    series: z.array(
      z
        .object({
          labels: metricsLabelsSchema,
          value: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict();

const metricsHistogramSchema = z
  .object({
    kind: z.literal('histogram'),
    name: z.string().trim().min(1),
    help: z.string().trim().min(1).optional(),
    series: z.array(
      z
        .object({
          labels: metricsLabelsSchema,
          buckets: z.array(
            z
              .object({
                le: z.union([z.number().finite(), z.literal('+Inf')]),
                count: z.number().finite(),
              })
              .strict(),
          ),
          sum: z.number().finite(),
          count: z.number().finite(),
        })
        .strict(),
    ),
  })
  .strict();

export const httpMetricsInstrumentSchema = z.union([metricsCounterGaugeSchema, metricsHistogramSchema]);

export const httpMetricsSchema = z
  .object({
    instruments: z.array(httpMetricsInstrumentSchema),
  })
  .strict();

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type SuccessStatus = 200 | 201 | 204;
export type HttpApiTag = 'Adapters' | 'Groups' | 'Cases' | 'Batches' | 'Runs' | 'Workers' | 'Ops';

export type HttpOperation = {
  id: string;
  method: HttpMethod;
  path: string;
  tag: HttpApiTag;
  query: z.ZodType;
  body: z.ZodType | null;
  response: z.ZodType | null;
  successStatus: SuccessStatus;
};

export const operations: readonly HttpOperation[] = [
  {
    id: 'listAdapters',
    method: 'GET',
    path: apiPaths.adapters,
    tag: 'Adapters',
    query: pageQuerySchema,
    body: null,
    response: pageSchema(httpAdapterSchema),
    successStatus: 200,
  },
  {
    id: 'getAdapter',
    method: 'GET',
    path: `${apiPaths.adapters}/:id`,
    tag: 'Adapters',
    query: emptyQuerySchema,
    body: null,
    response: httpAdapterSchema,
    successStatus: 200,
  },
  {
    id: 'listCases',
    method: 'GET',
    path: apiPaths.cases,
    tag: 'Cases',
    query: pageQuerySchema,
    body: null,
    response: pageSchema(httpCaseSchema),
    successStatus: 200,
  },
  {
    id: 'createCase',
    method: 'POST',
    path: apiPaths.cases,
    tag: 'Cases',
    query: emptyQuerySchema,
    body: httpCaseWriteSchema,
    response: httpCaseSchema,
    successStatus: 201,
  },
  {
    id: 'getCase',
    method: 'GET',
    path: `${apiPaths.cases}/:id`,
    tag: 'Cases',
    query: emptyQuerySchema,
    body: null,
    response: httpCaseSchema,
    successStatus: 200,
  },
  {
    id: 'updateCase',
    method: 'PUT',
    path: `${apiPaths.cases}/:id`,
    tag: 'Cases',
    query: emptyQuerySchema,
    body: httpCaseWriteSchema,
    response: httpCaseSchema,
    successStatus: 200,
  },
  {
    id: 'deleteCase',
    method: 'DELETE',
    path: `${apiPaths.cases}/:id`,
    tag: 'Cases',
    query: emptyQuerySchema,
    body: null,
    response: null,
    successStatus: 204,
  },
  {
    id: 'listGroups',
    method: 'GET',
    path: apiPaths.groups,
    tag: 'Groups',
    query: pageQuerySchema,
    body: null,
    response: pageSchema(httpGroupSchema),
    successStatus: 200,
  },
  {
    id: 'createGroup',
    method: 'POST',
    path: apiPaths.groups,
    tag: 'Groups',
    query: emptyQuerySchema,
    body: httpGroupWriteSchema,
    response: httpGroupSchema,
    successStatus: 201,
  },
  {
    id: 'getGroup',
    method: 'GET',
    path: `${apiPaths.groups}/:id`,
    tag: 'Groups',
    query: emptyQuerySchema,
    body: null,
    response: httpGroupSchema,
    successStatus: 200,
  },
  {
    id: 'updateGroup',
    method: 'PUT',
    path: `${apiPaths.groups}/:id`,
    tag: 'Groups',
    query: emptyQuerySchema,
    body: httpGroupWriteSchema,
    response: httpGroupSchema,
    successStatus: 200,
  },
  {
    id: 'deleteGroup',
    method: 'DELETE',
    path: `${apiPaths.groups}/:id`,
    tag: 'Groups',
    query: emptyQuerySchema,
    body: null,
    response: null,
    successStatus: 204,
  },
  {
    id: 'listRuns',
    method: 'GET',
    path: apiPaths.runs,
    tag: 'Runs',
    query: listRunsQuerySchema,
    body: null,
    response: pageSchema(httpRunSchema),
    successStatus: 200,
  },
  {
    id: 'listBatches',
    method: 'GET',
    path: apiPaths.batches,
    tag: 'Batches',
    query: pageQuerySchema,
    body: null,
    response: pageSchema(httpBatchSchema),
    successStatus: 200,
  },
  {
    id: 'createBatch',
    method: 'POST',
    path: apiPaths.batches,
    tag: 'Batches',
    query: emptyQuerySchema,
    body: httpBatchCreateSchema,
    response: httpBatchSchema,
    successStatus: 201,
  },
  {
    id: 'importBatch',
    method: 'POST',
    path: `${apiPaths.batches}/import`,
    tag: 'Batches',
    query: emptyQuerySchema,
    body: httpBatchImportSchema,
    response: httpBatchSchema,
    successStatus: 201,
  },
  {
    id: 'getBatch',
    method: 'GET',
    path: `${apiPaths.batches}/:id`,
    tag: 'Batches',
    query: emptyQuerySchema,
    body: null,
    response: httpBatchSchema,
    successStatus: 200,
  },
  {
    id: 'cancelBatch',
    method: 'POST',
    path: `${apiPaths.batches}/:id/cancel`,
    tag: 'Batches',
    query: emptyQuerySchema,
    body: null,
    response: httpBatchSchema,
    successStatus: 200,
  },
  {
    id: 'watchRun',
    method: 'GET',
    path: `${apiPaths.runs}/:id/events`,
    tag: 'Runs',
    query: emptyQuerySchema,
    body: null,
    response: null,
    successStatus: 200,
  },
  {
    id: 'getRunArtifact',
    method: 'GET',
    path: `${apiPaths.runs}/:id/artifacts/:artifactId`,
    tag: 'Runs',
    query: emptyQuerySchema,
    body: null,
    response: null,
    successStatus: 200,
  },
  {
    id: 'cancelRun',
    method: 'POST',
    path: `${apiPaths.runs}/:id/cancel`,
    tag: 'Runs',
    query: emptyQuerySchema,
    body: null,
    response: httpRunSchema,
    successStatus: 200,
  },
  {
    id: 'listWorkers',
    method: 'GET',
    path: apiPaths.workers,
    tag: 'Workers',
    query: pageQuerySchema,
    body: null,
    response: pageSchema(httpWorkerSchema),
    successStatus: 200,
  },
  {
    id: 'getWorker',
    method: 'GET',
    path: `${apiPaths.workers}/:id`,
    tag: 'Workers',
    query: emptyQuerySchema,
    body: null,
    response: httpWorkerSchema,
    successStatus: 200,
  },
  {
    id: 'getMetrics',
    method: 'GET',
    path: apiPaths.metrics,
    tag: 'Ops',
    query: emptyQuerySchema,
    body: null,
    response: httpMetricsSchema,
    successStatus: 200,
  },
];

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(':')) {
      if (actual.length === 0) return undefined;
      params[expected.slice(1)] = actual;
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

export function matchOperation(
  method: string,
  pathname: string,
): (HttpOperation & { params: Record<string, string> }) | undefined {
  for (const operation of operations) {
    if (operation.method !== method) continue;
    const params = matchPath(operation.path, pathname);
    if (params) return { ...operation, params };
  }
  return undefined;
}

import { z } from 'zod';

import { assertPreconditionSyntax } from './precondition.ts';
import { requireCaseDefinition } from './tree-document.ts';
import type { CaseDefinition, TreeNode } from './types.ts';

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

type TreeSchema = z.ZodType<TreeNode>;

const treeSchema: TreeSchema = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('Sequence'), children: z.array(treeSchema).min(1), ...preconditions }).strict(),
    z.object({ type: z.literal('ReactiveSequence'), children: z.array(treeSchema).min(1), ...preconditions }).strict(),
    z.object({ type: z.literal('Fallback'), children: z.array(treeSchema).min(1), ...preconditions }).strict(),
    z.object({ type: z.literal('ReactiveFallback'), children: z.array(treeSchema).min(1), ...preconditions }).strict(),
    z
      .object({
        type: z.literal('Parallel'),
        children: z.array(treeSchema).min(1),
        success_count: threshold.optional(),
        failure_count: threshold.optional(),
        ...preconditions,
      })
      .strict(),
    z
      .object({
        type: z.literal('ParallelAll'),
        children: z.array(treeSchema).min(1),
        max_failures: threshold.optional(),
        ...preconditions,
      })
      .strict(),
    z
      .object({ type: z.literal('RetryUntilSuccessful'), num_attempts: attempts, child: treeSchema, ...preconditions })
      .strict(),
    z.object({ type: z.literal('Repeat'), num_cycles: attempts, child: treeSchema, ...preconditions }).strict(),
    z
      .object({ type: z.literal('Timeout'), msec: z.number().int().positive(), child: treeSchema, ...preconditions })
      .strict(),
    z
      .object({ type: z.literal('Delay'), msec: z.number().int().positive(), child: treeSchema, ...preconditions })
      .strict(),
    z.object({ type: z.literal('Inverter'), child: treeSchema, ...preconditions }).strict(),
    z.object({ type: z.literal('ForceSuccess'), child: treeSchema, ...preconditions }).strict(),
    z.object({ type: z.literal('ForceFailure'), child: treeSchema, ...preconditions }).strict(),
    z.object({ type: z.literal('KeepRunningUntilFailure'), child: treeSchema, ...preconditions }).strict(),
    z.object({ type: z.literal('RunOnce'), child: treeSchema, ...preconditions }).strict(),
    z
      .object({
        type: z.literal('IfThenElse'),
        if: treeSchema,
        then: treeSchema,
        else: treeSchema.optional(),
        ...preconditions,
      })
      .strict(),
    z
      .object({
        type: z.literal('WhileDoElse'),
        if: treeSchema,
        then: treeSchema,
        else: treeSchema.optional(),
        ...preconditions,
      })
      .strict(),
    z
      .object({
        type: z.literal('Switch'),
        variable: z.string().trim().min(1),
        cases: z.array(z.string()),
        children: z.array(treeSchema),
        ...preconditions,
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
      })
      .strict(),
  ]),
);

export const caseDocumentSchema = z
  .object({
    main: z.string().trim().min(1),
    trees: z.record(recordKey, treeSchema),
    sessions: z.array(
      z
        .object({
          adapter: z.string().trim().min(1),
          actor: z.string().trim().min(1),
          ports: portBindings.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, session] of value.sessions.entries()) {
      const key = `${session.adapter}\0${session.actor}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `session ${session.adapter}/${session.actor} is declared more than once`,
          path: ['sessions', index],
        });
      }
      seen.add(key);
    }
    try {
      for (const [name, tree] of Object.entries(value.trees)) {
        assertSubTreeAcyclic(tree, value.trees, `root.trees.${name}`, [name]);
      }
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'definition is invalid',
      });
    }
  });

export function validateCaseDocument(definition: unknown): CaseDefinition {
  const document = requireCaseDefinition(definition);
  const result = caseDocumentSchema.safeParse(document);
  if (!result.success) {
    throw new Error(formatCaseDocumentError(result.error));
  }
  return result.data;
}

function assertSubTreeAcyclic(
  definition: TreeNode,
  trees: Record<string, TreeNode>,
  path: string,
  stack: string[],
): void {
  if (definition.type === 'SubTree') {
    if (stack.includes(definition.id)) {
      throw new Error(`${path} SubTree ${definition.id} is recursive`);
    }
    if (!(definition.id in trees)) {
      throw new Error(`${path} SubTree ${definition.id} is not defined`);
    }
    assertSubTreeAcyclic(trees[definition.id]!, trees, `${path}.tree`, [...stack, definition.id]);
    return;
  }
  if ('capability' in definition) return;
  if ('children' in definition) {
    definition.children.forEach((child, index) => {
      assertSubTreeAcyclic(child, trees, `${path}.children.${index}`, stack);
    });
    return;
  }
  if ('if' in definition) {
    assertSubTreeAcyclic(definition.if, trees, `${path}.if`, stack);
    assertSubTreeAcyclic(definition.then, trees, `${path}.then`, stack);
    if (definition.else) assertSubTreeAcyclic(definition.else, trees, `${path}.else`, stack);
    return;
  }
  assertSubTreeAcyclic(definition.child, trees, `${path}.child`, stack);
}

function formatCaseDocumentError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'definition is invalid';
  const path = issue.path.length > 0 ? `root.${issue.path.join('.')}` : 'root';
  if (path.endsWith('capability') && (issue.code === 'invalid_type' || issue.code === 'too_small'))
    return `${path} is required`;
  if (path.endsWith('type') && (issue.code === 'invalid_union' || issue.code === 'invalid_value'))
    return `${path} is unsupported`;
  if (issue.code === 'invalid_union' || issue.code === 'invalid_type') return `${path} is invalid`;
  return `${path}: ${issue.message}`;
}

import { z } from 'zod';

import { leafNodeTypes, type JsonObject, type LeafNode, type LeafNodeType, type TickResult } from './types.ts';

export const portDirections = ['in', 'out', 'inout'] as const;
export type PortDirection = (typeof portDirections)[number];

export type PortDefinition = {
  name: string;
  direction: PortDirection;
  schema: JsonObject;
  required?: boolean;
  default?: unknown;
};

export type CapabilityDefinition = {
  key: string;
  kind: LeafNodeType;
  label: string;
  ports: PortDefinition[];
};

export type CatalogCapability = CapabilityDefinition & {
  adapter: string;
};

export type RuntimeLeaf = LeafNode & {
  path: string;
};

export type LeafTickContext = {
  input: Record<string, unknown>;
};

export type AdapterManifest = {
  id: string;
  moduleEntry: string;
  capabilities: CapabilityDefinition[];
  session?: { ports: PortDefinition[] };
};

export type RecordArtifactInput = {
  name: string;
  mediaType: string;
  path: string;
};

export type AdapterSessionContext = {
  runId: string;
  actor: string;
  resourceRoot: string;
  recordArtifact(input: RecordArtifactInput): { id: string };
  input: Record<string, unknown>;
};

export type AdapterSession = {
  tick(leaf: RuntimeLeaf, context: LeafTickContext): Promise<TickResult>;
  halt(leaf: RuntimeLeaf): Promise<void>;
  cleanup(): Promise<void>;
};

export type AdapterModule = {
  createSession(context: AdapterSessionContext): Promise<AdapterSession>;
};

const jsonObject = z.record(z.string(), z.unknown());

export const portDefinitionSchema: z.ZodType<PortDefinition> = z
  .object({
    name: z.string().trim().min(1),
    direction: z.enum(portDirections),
    schema: jsonObject,
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();

const sessionPortsSchema = z.array(portDefinitionSchema).superRefine((ports, ctx) => {
  const names = new Set<string>();
  for (const [index, port] of ports.entries()) {
    if (port.direction !== 'in') {
      ctx.addIssue({
        code: 'custom',
        message: 'session ports must use direction in',
        path: [index, 'direction'],
      });
    }
    if (names.has(port.name)) {
      ctx.addIssue({
        code: 'custom',
        message: `session port ${port.name} is declared more than once`,
        path: [index, 'name'],
      });
    }
    names.add(port.name);
  }
});

export const adapterManifestSchema: z.ZodType<AdapterManifest> = z
  .object({
    id: z.string().trim().min(1),
    moduleEntry: z.string().trim().min(1),
    capabilities: z.array(
      z
        .object({
          key: z.string().trim().min(1),
          kind: z.enum(leafNodeTypes),
          label: z.string().trim().min(1),
          ports: z.array(portDefinitionSchema),
        })
        .strict(),
    ),
    session: z.object({ ports: sessionPortsSchema }).strict().optional(),
  })
  .strict();

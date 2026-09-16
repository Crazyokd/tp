import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adapterManifestSchema,
  type AdapterSession,
  type AdapterSessionContext,
  type LeafTickContext,
  type PortDefinition,
} from '../src/adapter-contract.ts';
import type { LeafNode, TickResult } from '../src/types.ts';

test('manifest declares ports', () => {
  const parsed = adapterManifestSchema.parse({
    id: 'demo',
    moduleEntry: '@tp/adapter-demo',
    capabilities: [
      {
        key: 'demo.go',
        kind: 'Action',
        label: 'Go',
        ports: [
          { name: 'target', direction: 'in', schema: { type: 'string' } },
          { name: 'arrived', direction: 'out', schema: { type: 'object' }, required: false },
          { name: 'pose', direction: 'inout', schema: { type: 'object' } },
        ],
      },
    ],
  });

  assert.equal(parsed.capabilities[0]?.ports[0]?.direction, 'in');
  assert.equal(parsed.capabilities[0]?.ports[1]?.required, false);
});

test('manifest rejects a capability without ports or with unknown fields', () => {
  assert.throws(() =>
    adapterManifestSchema.parse({
      id: 'demo',
      moduleEntry: '@tp/adapter-demo',
      capabilities: [
        {
          key: 'demo.go',
          kind: 'Action',
          label: 'Go',
        },
      ],
    }),
  );
  assert.throws(() =>
    adapterManifestSchema.parse({
      id: 'demo',
      moduleEntry: '@tp/adapter-demo',
      capabilities: [
        {
          key: 'demo.go',
          kind: 'Action',
          label: 'Go',
          ports: [],
          extra: true,
        },
      ],
    }),
  );
});

test('session context is only runId and actor', () => {
  const context: AdapterSessionContext = { runId: 'run-1', actor: 'robot1' };
  assert.equal(context.runId, 'run-1');
  assert.equal(context.actor, 'robot1');
  assert.deepEqual(Object.keys(context).sort(), ['actor', 'runId']);
});

test('tick receives assembled input and returns status plus port output', async () => {
  const leaf: LeafNode = {
    type: 'Action',
    adapter: 'demo',
    actor: 'robot1',
    capability: 'demo.go',
    ports: { target: { literal: 'A' }, pose: { key: 'r1.pose' } },
  };
  const tickContext: LeafTickContext = { input: { target: 'A' } };
  const session: AdapterSession = {
    async tick(_leaf, _context) {
      return { status: 'SUCCESS', output: { pose: { x: 1 } } } satisfies TickResult;
    },
    async halt() {},
    async cleanup() {},
  };

  const result = await session.tick(leaf, tickContext);
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.output, { pose: { x: 1 } });
});

test('port definition allows inout and optional default', () => {
  const port: PortDefinition = {
    name: 'count',
    direction: 'inout',
    schema: { type: 'integer' },
    required: false,
    default: 0,
  };
  assert.equal(port.direction, 'inout');
  assert.equal(port.default, 0);
});

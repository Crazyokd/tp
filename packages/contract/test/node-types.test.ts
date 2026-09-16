import assert from 'node:assert/strict';
import { test } from 'node:test';

import { controlNodeTypes, nodeTypes } from '../src/types.ts';

test('nodeTypes includes Inverter as a decorator, not a control node', () => {
  assert.ok(nodeTypes.includes('Inverter'));
  assert.equal(controlNodeTypes.includes('Inverter' as (typeof controlNodeTypes)[number]), false);
});

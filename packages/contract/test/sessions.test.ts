import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectLeafSessions, sessionsForLeaves } from '../src/sessions.ts';
import type { TreeNode } from '../src/types.ts';

const trees: Record<string, TreeNode> = {
  Main: {
    type: 'Sequence',
    children: [
      { type: 'Action', adapter: 'demo', actor: 'robot', capability: 'demo.system.ready', ports: {} },
      { type: 'Action', adapter: 'browser', actor: 'robot', capability: 'browser.goto', ports: {} },
      { type: 'Action', adapter: 'demo', actor: 'robot', capability: 'demo.mapping.start', ports: {} },
    ],
  },
};

test('collectLeafSessions indexes unique adapter actor pairs', () => {
  assert.deepEqual(collectLeafSessions(trees), [
    { adapter: 'demo', actor: 'robot' },
    { adapter: 'browser', actor: 'robot' },
  ]);
});

test('sessionsForLeaves fills empty ports for each leaf pair', () => {
  assert.deepEqual(sessionsForLeaves(trees), [
    { adapter: 'demo', actor: 'robot', ports: {} },
    { adapter: 'browser', actor: 'robot', ports: {} },
  ]);
});

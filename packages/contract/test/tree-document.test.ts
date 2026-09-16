import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requireCaseDefinition } from '../src/tree-document.ts';

test('accepts a tree document and rejects unknown shapes', () => {
  const document = {
    main: 'Main',
    trees: {
      Main: {
        type: 'Fallback' as const,
        children: [
          {
            type: 'RetryUntilSuccessful' as const,
            num_attempts: 3,
            child: {
              type: 'Timeout' as const,
              msec: 1000,
              child: {
                type: 'Action' as const,
                adapter: 'demo',
                actor: 'robot',
                capability: 'demo.read',
                ports: { name: { key: 'demo.name' } },
              },
            },
          },
        ],
      },
    },
  };

  assert.deepEqual(requireCaseDefinition(document), document);
  assert.throws(
    () =>
      requireCaseDefinition({
        type: 'Unknown',
        children: [{ type: 'Action', adapter: 'demo', actor: 'robot', capability: 'demo.read' }],
      }),
    /tree document/,
  );
  assert.throws(
    () =>
      requireCaseDefinition({
        main: 'Main',
      }),
    /tree document/,
  );
});

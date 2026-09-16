import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateCaseDocument } from '../src/case-document.ts';

const leaf = {
  type: 'Action' as const,
  adapter: 'test',
  actor: 'robot',
  capability: 'pass',
};

function doc(node: object) {
  return { main: 'Main', trees: { Main: node } };
}

test('rejects extra keys on the document', () => {
  assert.throws(
    () => validateCaseDocument({ main: 'Main', trees: { Main: { type: 'Sequence', children: [leaf] } }, version: 1 }),
    /unknown|unrecognized|strict/i,
  );
});

test('rejects an empty Sequence', () => {
  assert.throws(() => validateCaseDocument(doc({ type: 'Sequence', children: [] })), /children/);
});

test('rejects an unparsable precondition', () => {
  assert.throws(
    () => validateCaseDocument(doc({ type: 'Sequence', children: [leaf], _skipIf: '???' })),
    /precondition/,
  );
});

test('rejects Switch without a default child', () => {
  assert.throws(
    () =>
      validateCaseDocument(
        doc({
          type: 'Switch',
          variable: 'state',
          cases: ['idle'],
          children: [leaf],
        }),
      ),
    /Switch|children|default/,
  );
});

test('rejects string remap values', () => {
  assert.throws(
    () =>
      validateCaseDocument({
        main: 'Main',
        trees: {
          Main: { type: 'SubTree', id: 'Inner', remap: { battery: '{battery}' } },
          Inner: { type: 'Sequence', children: [leaf] },
        },
      }),
    /remap/,
  );
});

test('accepts Switch with a default child', () => {
  assert.doesNotThrow(() =>
    validateCaseDocument(
      doc({
        type: 'Switch',
        variable: 'state',
        cases: ['idle'],
        children: [leaf, leaf],
      }),
    ),
  );
});

test('rejects padded tree keys that would collapse under trim', () => {
  const seq = { type: 'Sequence' as const, children: [leaf] };
  assert.throws(() => validateCaseDocument({ main: 'A', trees: { A: seq, ' A': seq } }), /trees|key|invalid/i);
});

test('rejects an Inverter without a child', () => {
  assert.throws(
    () => validateCaseDocument(doc({ type: 'Inverter' })),
    /root(\.trees\.Main)?\.child is invalid|root is invalid/,
  );
});

test('rejects a leaf node without a capability', () => {
  assert.throws(() => validateCaseDocument(doc({ type: 'Action' })), /adapter is invalid|capability is required/);
});

test('rejects an unknown node type', () => {
  assert.throws(() => validateCaseDocument(doc({ type: 'Workflow', children: [] })), /type is unsupported|is invalid/);
});

test('accepts key remap and rejects a SubTree cycle', () => {
  assert.doesNotThrow(() =>
    validateCaseDocument({
      main: 'Main',
      trees: {
        Main: { type: 'SubTree', id: 'Inner', remap: { battery: { key: 'battery' } } },
        Inner: { type: 'Sequence', children: [leaf] },
      },
    }),
  );
  assert.throws(
    () =>
      validateCaseDocument({
        main: 'Main',
        trees: {
          Main: { type: 'SubTree', id: 'Inner' },
          Inner: { type: 'SubTree', id: 'Main' },
        },
      }),
    /recursive|cycle|环/,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AdapterManifest, CapabilityDefinition, PortDefinition } from '../src/adapter-contract.ts';
import { validateCaseCatalog } from '../src/case-catalog.ts';
import { sessionsForLeaves } from '../src/sessions.ts';
import type { CaseDefinition, LeafNode, SessionBinding, TreeNode } from '../src/types.ts';

function leaf(capability: string, extra: Partial<LeafNode> = {}): LeafNode {
  return {
    type: extra.type ?? 'Action',
    adapter: extra.adapter ?? 'test',
    actor: extra.actor ?? 'robot',
    capability,
    ports: extra.ports ?? {},
    ...extra,
  };
}

function doc(node: TreeNode, extraTrees: Record<string, TreeNode> = {}, sessions?: SessionBinding[]): CaseDefinition {
  const trees = { Main: node, ...extraTrees };
  return { main: 'Main', trees, sessions: sessions ?? sessionsForLeaves(trees) };
}

function port(
  name: string,
  direction: PortDefinition['direction'],
  extra: Partial<PortDefinition> = {},
): PortDefinition {
  return { name, direction, schema: extra.schema ?? { type: 'string' }, ...extra };
}

function adapter(capabilities: CapabilityDefinition[], extra: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id: extra.id ?? 'test',
    moduleEntry: extra.moduleEntry ?? '@tp/test',
    capabilities,
    ...extra,
  };
}

const pass = adapter([{ key: 'pass', kind: 'Action', label: 'Pass', ports: [] }]);

test('accepts a registered action leaf', () => {
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('pass')), [pass]));
});

test('rejects an unregistered capability', () => {
  assert.throws(
    () => validateCaseCatalog(doc(leaf('missing')), [pass]),
    /root\.trees\.Main\.capability test\/missing is not registered/,
  );
});

test('rejects a capability used with the wrong leaf kind', () => {
  const manifests = [adapter([{ key: 'ready', kind: 'Condition', label: 'Ready', ports: [] }])];
  assert.throws(() => validateCaseCatalog(doc(leaf('ready')), manifests), /requires Condition, received Action/);
});

test('rejects an undeclared port binding', () => {
  assert.throws(
    () => validateCaseCatalog(doc(leaf('pass', { ports: { extra: { key: 'x' } } })), [pass]),
    /ports\.extra is not declared/,
  );
});

test('rejects a required input that is unbound and has no default', () => {
  const manifests = [
    adapter([
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in')],
      },
    ]),
  ];
  assert.throws(() => validateCaseCatalog(doc(leaf('named')), manifests), /ports\.name is required/);
});

test('accepts a required input satisfied by a manifest default', () => {
  const manifests = [
    adapter([
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in', { default: 'ok' })],
      },
    ]),
  ];
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('named')), manifests));
});

test('rejects a required output that is unbound', () => {
  const manifests = [
    adapter([
      {
        key: 'write',
        kind: 'Action',
        label: 'Write',
        ports: [port('result', 'out')],
      },
    ]),
  ];
  assert.throws(
    () => validateCaseCatalog(doc(leaf('write')), manifests),
    /ports\.result must bind an output to a blackboard key/,
  );
});

test('accepts a required output satisfied by a manifest default', () => {
  const manifests = [
    adapter([
      {
        key: 'write',
        kind: 'Action',
        label: 'Write',
        ports: [port('result', 'out', { default: '{result}' })],
      },
    ]),
  ];
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('write')), manifests));
});

test('accepts an optional unbound output', () => {
  const manifests = [
    adapter([
      {
        key: 'write',
        kind: 'Action',
        label: 'Write',
        ports: [port('result', 'out', { required: false })],
      },
    ]),
  ];
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('write')), manifests));
});

test('rejects an output bound to a literal', () => {
  const manifests = [
    adapter([
      {
        key: 'write',
        kind: 'Action',
        label: 'Write',
        ports: [port('result', 'out', { required: false })],
      },
    ]),
  ];
  assert.throws(
    () => validateCaseCatalog(doc(leaf('write', { ports: { result: { literal: 'nope' } } })), manifests),
    /ports\.result is an output and cannot be a literal/,
  );
});

test('accepts an input literal that matches schema', () => {
  const manifests = [
    adapter([
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in')],
      },
    ]),
  ];
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('named', { ports: { name: { literal: 'ok' } } })), manifests));
});

test('rejects an input literal that does not match schema', () => {
  const manifests = [
    adapter([
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in')],
      },
    ]),
  ];
  assert.throws(
    () => validateCaseCatalog(doc(leaf('named', { ports: { name: { literal: 1 } } })), manifests),
    /ports\.name literal does not match schema/,
  );
});

test('accepts an inout literal that matches schema', () => {
  const manifests = [
    adapter([
      {
        key: 'edit',
        kind: 'Action',
        label: 'Edit',
        ports: [port('value', 'inout')],
      },
    ]),
  ];
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('edit', { ports: { value: { literal: 'ok' } } })), manifests));
});

test('rejects an inout literal that does not match schema', () => {
  const manifests = [
    adapter([
      {
        key: 'edit',
        kind: 'Action',
        label: 'Edit',
        ports: [port('value', 'inout')],
      },
    ]),
  ];
  assert.throws(
    () => validateCaseCatalog(doc(leaf('edit', { ports: { value: { literal: 1 } } })), manifests),
    /ports\.value literal does not match schema/,
  );
});

test('accepts a blackboard key without checking the key', () => {
  const manifests = [
    adapter([
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in')],
      },
    ]),
  ];
  assert.doesNotThrow(() =>
    validateCaseCatalog(doc(leaf('named', { ports: { name: { key: 'whatever' } } })), manifests),
  );
});

const writeNumber = adapter([
  {
    key: 'write-number',
    kind: 'Action',
    label: 'Write number',
    ports: [port('value', 'out', { schema: { type: 'number' } })],
  },
]);

const readString = adapter(
  [
    {
      key: 'read-string',
      kind: 'Action',
      label: 'Read string',
      ports: [port('value', 'in', { schema: { type: 'string' } })],
    },
  ],
  { id: 'reader' },
);

const readNumber = adapter(
  [
    {
      key: 'read-number',
      kind: 'Action',
      label: 'Read number',
      ports: [port('value', 'in', { schema: { type: 'number' } })],
    },
  ],
  { id: 'reader' },
);

test('rejects the same key bound to unequal port schemas', () => {
  assert.throws(
    () =>
      validateCaseCatalog(
        doc({
          type: 'Sequence',
          children: [
            leaf('write-number', { ports: { value: { key: 'x' } } }),
            leaf('read-string', { adapter: 'reader', ports: { value: { key: 'x' } } }),
          ],
        }),
        [writeNumber, readString],
      ),
    /ports\.value key x schema does not match/,
  );
});

test('accepts the same key bound to deeply equal port schemas', () => {
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc({
        type: 'Sequence',
        children: [
          leaf('write-number', { ports: { value: { key: 'x' } } }),
          leaf('read-number', { adapter: 'reader', ports: { value: { key: 'x' } } }),
        ],
      }),
      [writeNumber, readNumber],
    ),
  );
});

test('rejects a remapped inner key that collides with an outer key of another schema', () => {
  assert.throws(
    () =>
      validateCaseCatalog(
        doc(
          {
            type: 'Sequence',
            children: [
              leaf('write-number', { ports: { value: { key: 'outer' } } }),
              { type: 'SubTree', id: 'Foo', remap: { inner: { key: 'outer' } } },
            ],
          },
          { Foo: leaf('read-string', { adapter: 'reader', ports: { value: { key: 'inner' } } }) },
        ),
        [writeNumber, readString],
      ),
    /ports\.value key outer schema does not match/,
  );
});

test('accepts a remapped inner key that matches the outer key schema', () => {
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(
        {
          type: 'Sequence',
          children: [
            leaf('write-number', { ports: { value: { key: 'outer' } } }),
            { type: 'SubTree', id: 'Foo', remap: { inner: { key: 'outer' } } },
          ],
        },
        { Foo: leaf('read-number', { adapter: 'reader', ports: { value: { key: 'inner' } } }) },
      ),
      [writeNumber, readNumber],
    ),
  );
});

test('does not collide an unmapped SubTree key with the same name on the parent', () => {
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(
        {
          type: 'Sequence',
          children: [leaf('write-number', { ports: { value: { key: 'x' } } }), { type: 'SubTree', id: 'Foo' }],
        },
        { Foo: leaf('read-string', { adapter: 'reader', ports: { value: { key: 'x' } } }) },
      ),
      [writeNumber, readString],
    ),
  );
});

test('does not collide the same key name across an unreferenced tree and Main', () => {
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(leaf('write-number', { ports: { value: { key: 'x' } } }), {
        Dead: leaf('read-string', { adapter: 'reader', ports: { value: { key: 'x' } } }),
      }),
      [writeNumber, readString],
    ),
  );
});

test('rejects a bad leaf in an unreferenced tree', () => {
  assert.throws(
    () => validateCaseCatalog(doc(leaf('pass'), { Dead: leaf('missing') }), [pass]),
    /root\.trees\.Dead\.capability test\/missing is not registered/,
  );
});

test('ignores actor', () => {
  assert.doesNotThrow(() => validateCaseCatalog(doc(leaf('pass', { actor: '???not-registered???' })), [pass]));
});

test('rejects duplicate adapter ids', () => {
  assert.throws(
    () =>
      validateCaseCatalog(doc(leaf('pass')), [
        pass,
        adapter([{ key: 'other', kind: 'Action', label: 'Other', ports: [] }]),
      ]),
    /adapter test is declared more than once/,
  );
});

test('rejects duplicate capability keys in one adapter', () => {
  assert.throws(
    () =>
      validateCaseCatalog(doc(leaf('pass')), [
        adapter([
          { key: 'pass', kind: 'Action', label: 'Pass', ports: [] },
          { key: 'pass', kind: 'Action', label: 'Again', ports: [] },
        ]),
      ]),
    /capability pass is declared more than once by adapter test/,
  );
});

test('reports the first tree error and stops', () => {
  assert.throws(
    () =>
      validateCaseCatalog(
        {
          main: 'Main',
          trees: {
            Alpha: leaf('missing-a'),
            Beta: leaf('missing-b'),
          },
          sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
        },
        [pass],
      ),
    /root\.trees\.Alpha\.capability test\/missing-a is not registered/,
  );
});

test('rejects a hand-built manifest whose port schema is outside the dialect', () => {
  assert.throws(
    () =>
      validateCaseCatalog(doc(leaf('named', { ports: { name: { literal: 'ok' } } })), [
        adapter([
          {
            key: 'named',
            kind: 'Action',
            label: 'Named',
            ports: [port('name', 'in', { schema: { type: 'string', pattern: '^ok$' } })],
          },
        ]),
      ]),
    /unsupported JSON Schema keyword pattern/,
  );
});

test('treats omitted additionalProperties as false when comparing key schemas', () => {
  const writePose = adapter([
    {
      key: 'write-pose',
      kind: 'Action',
      label: 'Write pose',
      ports: [
        port('value', 'out', {
          schema: {
            type: 'object',
            properties: { x: { type: 'number' } },
          },
        }),
      ],
    },
  ]);
  const readPose = adapter(
    [
      {
        key: 'read-pose',
        kind: 'Action',
        label: 'Read pose',
        ports: [
          port('value', 'in', {
            schema: {
              type: 'object',
              properties: { x: { type: 'number' } },
              additionalProperties: false,
            },
          }),
        ],
      },
    ],
    { id: 'reader' },
  );
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc({
        type: 'Sequence',
        children: [
          leaf('write-pose', { ports: { value: { key: 'pose' } } }),
          leaf('read-pose', { adapter: 'reader', ports: { value: { key: 'pose' } } }),
        ],
      }),
      [writePose, readPose],
    ),
  );
});

test('rejects a case that omits a session row for a leaf actor', () => {
  assert.throws(() => validateCaseCatalog(doc(leaf('pass'), {}, []), [pass]), /root\.sessions is missing test\/robot/);
});

test('rejects a session row that no leaf uses', () => {
  assert.throws(
    () =>
      validateCaseCatalog(
        doc(leaf('pass'), {}, [
          { adapter: 'test', actor: 'robot' },
          { adapter: 'test', actor: 'spare' },
        ]),
        [pass],
      ),
    /not used by any leaf/,
  );
});

test('treats demo and browser actors with the same name as distinct sessions', () => {
  const browser = adapter([{ key: 'pass', kind: 'Action', label: 'Pass', ports: [] }], { id: 'browser' });
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(
        {
          type: 'Sequence',
          children: [leaf('pass'), leaf('pass', { adapter: 'browser' })],
        },
        {},
        [
          { adapter: 'test', actor: 'robot' },
          { adapter: 'browser', actor: 'robot' },
        ],
      ),
      [pass, browser],
    ),
  );
});

test('rejects a missing required session port', () => {
  const demo = adapter([{ key: 'pass', kind: 'Action', label: 'Pass', ports: [] }], {
    id: 'demo',
    session: { ports: [port('container', 'in')] },
  });
  assert.throws(
    () =>
      validateCaseCatalog(doc(leaf('pass', { adapter: 'demo' }), {}, [{ adapter: 'demo', actor: 'robot' }]), [demo]),
    /container is required/,
  );
});

test('accepts a session port wired to a blackboard key and rejects a schema clash', () => {
  const named = adapter(
    [
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in', { schema: { type: 'number' } })],
      },
    ],
    { session: { ports: [port('label', 'in', { schema: { type: 'string' } })] } },
  );
  assert.throws(
    () =>
      validateCaseCatalog(
        doc(leaf('named', { ports: { name: { key: 'shared' } } }), {}, [
          { adapter: 'test', actor: 'robot', ports: { label: { key: 'shared' } } },
        ]),
        [named],
      ),
    /key shared schema does not match/,
  );
  const aligned = adapter(
    [
      {
        key: 'named',
        kind: 'Action',
        label: 'Named',
        ports: [port('name', 'in')],
      },
    ],
    { session: { ports: [port('label', 'in')] } },
  );
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(leaf('named', { ports: { name: { key: 'shared' } } }), {}, [
        { adapter: 'test', actor: 'robot', ports: { label: { key: 'shared' } } },
      ]),
      [aligned],
    ),
  );
});

test('accepts a required session port literal', () => {
  const demo = adapter([{ key: 'pass', kind: 'Action', label: 'Pass', ports: [] }], {
    id: 'demo',
    session: { ports: [port('container', 'in')] },
  });
  assert.doesNotThrow(() =>
    validateCaseCatalog(
      doc(leaf('pass', { adapter: 'demo' }), {}, [
        { adapter: 'demo', actor: 'robot', ports: { container: { literal: 'demo' } } },
      ]),
      [demo],
    ),
  );
});

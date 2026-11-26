import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CaseDefinition, PortBinding } from '@tp/contract';
import { BuilderPage } from '../src/features/BuilderPage.tsx';

function render(binding: PortBinding): string {
  const leaf = { type: 'Action', adapter: 'demo', actor: 'browser', capability: 'demo.open', ports: {} } as const;
  const definition: CaseDefinition = {
    main: 'Main',
    trees: { Main: leaf },
    sessions: [{ adapter: 'demo', actor: 'browser', ports: { origin: binding } }],
  };
  const noop = () => undefined;
  return renderToStaticMarkup(
    createElement(BuilderPage, {
      caseName: 'wired origin',
      caseDescription: '',
      adapters: [
        {
          id: 'demo',
          moduleEntry: 'demo',
          capabilities: [],
          session: { ports: [{ name: 'origin', direction: 'in', schema: { type: 'string' }, required: true }] },
        },
      ],
      capabilities: [],
      definition,
      definitionText: JSON.stringify(definition),
      selected: leaf,
      selectedPath: '',
      status: '',
      onAddNode: noop,
      onCaseNameChange: noop,
      onCaseDescriptionChange: noop,
      onCreate: noop,
      onDeleteNode: noop,
      onMoveNode: noop,
      onReplaceType: noop,
      onSave: noop,
      onSelect: noop,
      onStartRun: noop,
      onUpdateLeaf: noop,
      onUpdateNumber: noop,
      onUpdateSessions: noop,
    }),
  );
}

test('Builder shows the existing Session blackboard key and its selected wiring mode', () => {
  const html = render({ key: 'hmi.robot1.origin' });
  assert.match(html, /data-testid="session-port-origin"[^>]*value="hmi\.robot1\.origin"/);
  assert.match(html, /<option value="key" selected="">黑板键<\/option>/);
  assert.doesNotMatch(html, /只允许字面量/);
});

test('Builder continues to show a literal Session input as a literal', () => {
  const html = render({ literal: 'http://127.0.0.1:5173' });
  assert.match(html, /data-testid="session-port-origin"[^>]*value="http:\/\/127\.0\.0\.1:5173"/);
});

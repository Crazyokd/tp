import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CaseDefinition, TestCase, TestGroup } from '@tp/contract';
import { GroupsPage } from '../src/features/GroupsPage.tsx';

const now = '2026-11-16T00:00:00.000Z';
const definition: CaseDefinition = {
  main: 'Main',
  trees: { Main: { type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} } },
  sessions: [{ adapter: 'test', actor: 'robot', ports: {} }],
};
const cases: TestCase[] = [
  {
    id: 'shared',
    name: 'Shared readiness case',
    description: 'Wait for the system',
    definition,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'other',
    name: 'Other navigation case',
    description: 'Navigate to a station',
    definition,
    createdAt: now,
    updatedAt: now,
  },
];
const groups: TestGroup[] = [
  { id: 'http', name: 'HTTP suite', caseIds: ['shared'], createdAt: now, updatedAt: now },
  { id: 'inttest', name: 'Integration suite', caseIds: ['shared', 'other'], createdAt: now, updatedAt: now },
];
const callbacks = {
  onSave: async () => {
    throw new Error('rendering must not save');
  },
  onRemove: async () => {
    throw new Error('rendering must not delete');
  },
  onStart: async () => {
    throw new Error('rendering must not start a run');
  },
};
test('Groups initially shows the current suite members without opening an editor', () => {
  const html = renderToStaticMarkup(createElement(GroupsPage, { groups, cases, ...callbacks }));
  assert.match(html, /HTTP suite/);
  assert.match(html, /Integration suite/);
  assert.match(html, /Shared readiness case/);
  assert.doesNotMatch(html, /Other navigation case/);
  assert.doesNotMatch(html, /<form/);
  assert.match(html, /编辑成员/);
  assert.match(html, /运行组/);
});
test('No groups shows an empty state and a create action', () => {
  const html = renderToStaticMarkup(createElement(GroupsPage, { groups: [], cases, ...callbacks }));
  assert.match(html, /暂无分组/);
  assert.match(html, /新建组/);
  assert.doesNotMatch(html, /<form/);
});
test('An empty current group has a disabled run action', () => {
  const html = renderToStaticMarkup(
    createElement(GroupsPage, { groups: [{ ...groups[0]!, caseIds: [] }], cases, ...callbacks }),
  );
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?运行组/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { appViewHash, parseAppLocation } from '../src/domain/app-view.ts';

test('parseAppLocation treats empty and unknown hashes as runs', () => {
  assert.equal(parseAppLocation('').view, 'runs');
  assert.equal(parseAppLocation('#').view, 'runs');
  assert.equal(parseAppLocation('#/unknown').view, 'runs');
  assert.equal(parseAppLocation('#runs').view, 'runs');
});

test('parseAppLocation recognizes module hashes', () => {
  assert.equal(parseAppLocation('#/runs').view, 'runs');
  assert.equal(parseAppLocation('#/cases').view, 'cases');
  assert.equal(parseAppLocation('#/groups').view, 'groups');
  assert.equal(parseAppLocation('#/builder').view, 'builder');
  assert.equal(parseAppLocation('#/workers').view, 'workers');
});

test('parseAppLocation keeps a run batch permalink on the runs view', () => {
  assert.deepEqual(parseAppLocation('#/runs/ci-196497-1072596'), {
    view: 'runs',
    batchId: 'ci-196497-1072596',
  });
  assert.deepEqual(parseAppLocation('#/runs/batch%20a'), { view: 'runs', batchId: 'batch a' });
  assert.deepEqual(parseAppLocation('#/runs'), { view: 'runs', batchId: null });
  assert.deepEqual(parseAppLocation('#/cases'), { view: 'cases', batchId: null });
  assert.equal(parseAppLocation('#/runs/ci-1').view, 'runs');
});

test('appViewHash writes the matching location hash', () => {
  assert.equal(appViewHash('runs'), '#/runs');
  assert.equal(appViewHash('cases'), '#/cases');
  assert.equal(appViewHash('groups'), '#/groups');
  assert.equal(appViewHash('builder'), '#/builder');
  assert.equal(appViewHash('workers'), '#/workers');
});

test('App shell shows one module at a time and keeps create-run on the current page', async () => {
  const app = await readFile('src/App.tsx', 'utf8');
  const cases = await readFile('src/features/CasesPage.tsx', 'utf8');
  const builder = await readFile('src/features/BuilderPage.tsx', 'utf8');
  const runs = await readFile('src/features/RunsPage.tsx', 'utf8');
  const styles = await readFile('src/styles.css', 'utf8');
  const workers = await readFile('src/features/WorkersPage.tsx', 'utf8');

  assert.match(app, /data-testid="app-nav"/);
  assert.match(app, /data-view=\{item\.id\}/);
  assert.match(app, /id: 'runs'/);
  assert.match(app, /id: 'cases'/);
  assert.match(app, /id: 'builder'/);
  assert.match(app, /id: 'workers'/);
  assert.match(app, /listWorkers/);
  assert.doesNotMatch(app, /workerId/);
  assert.match(app, /parseAppLocation/);
  assert.match(app, /appViewHash/);
  assert.doesNotMatch(app, /grid-template-columns: minmax\(0, 1fr\) 360px/);

  assert.match(cases, /data-testid="cases-page"/);
  assert.match(builder, /data-testid="builder-page"/);
  assert.match(builder, /data-testid="sessions-panel"/);
  assert.doesNotMatch(builder, /data-testid="session-add"/);
  assert.doesNotMatch(builder, /data-testid="session-remove"/);
  assert.doesNotMatch(builder, /data-testid="session-adapter"/);
  assert.doesNotMatch(builder, /data-testid="session-actor"/);
  assert.match(builder, /session-port-/);
  assert.match(builder, /data-testid="bt-editor"/);
  assert.match(builder, /data-testid="node-type"/);
  assert.match(builder, /data-testid="builder-view"/);
  assert.match(builder, /data-testid="builder-view-canvas"/);
  assert.match(builder, /data-testid="builder-view-json"/);
  assert.match(builder, /role="radiogroup"/);
  assert.match(builder, /highlightJson\(definitionText\)/);
  assert.match(builder, /className="tree-panel"(?:(?!<\/section>)[\s\S])*data-testid="definition"/);
  assert.doesNotMatch(builder, /Definition JSON/);
  assert.doesNotMatch(builder, /<textarea data-testid="definition"/);
  assert.match(builder, /leaf:\$\{capability\.adapter\}::\$\{capability\.key\}/);
  const definitionJsonRule = styles.match(/\.definition-json\s*\{[^}]*\}/);
  assert.ok(definitionJsonRule);
  assert.match(definitionJsonRule[0], /max-height:\s*none;/);
  assert.match(definitionJsonRule[0], /min-height:\s*0;/);
  assert.match(definitionJsonRule[0], /height:\s*100%;/);
  assert.match(runs, /data-testid="runs-page"/);
  assert.match(runs, /Runs List/);
  assert.match(workers, /data-testid="workers-page"/);
  assert.match(workers, /runId/);

  assert.match(app, /setView\('builder'\)/);
  assert.match(app, /requireCaseDefinition\(item\.definition\)/);
  assert.doesNotMatch(app, /setView\('runs'\).*\/api\/runs/);
});

test('malformed and incomplete batch links follow unknown-hash routing', () => {
  for (const hash of ['#/runs/%', '#/runs/%E0%A4%A', '#/runs/', '#/runs/batch/extra']) {
    assert.deepEqual(parseAppLocation(hash), { view: 'runs', batchId: null });
  }
  assert.deepEqual(parseAppLocation('#/groups'), { view: 'groups', batchId: null });
});

test('batch links preserve exact imported IDs', () => {
  for (const id of ['测试/a', 'a\u0000b', 'a�b', 'quote"bracket]', 'back\\slash']) {
    assert.deepEqual(parseAppLocation(`#/runs/${encodeURIComponent(id)}`), { view: 'runs', batchId: id });
  }
});

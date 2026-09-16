import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('product code uses a typed React Flow stack', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const web = JSON.parse(await readFile('packages/web/package.json', 'utf8'));
  const contract = JSON.parse(await readFile('packages/contract/package.json', 'utf8'));

  assert.ok(web.dependencies.react);
  assert.ok(web.dependencies['react-dom']);
  assert.ok(web.dependencies['@xyflow/react']);
  assert.ok(contract.dependencies.zod);
  assert.ok(pkg.devDependencies.typescript);
  assert.match(pkg.scripts.typecheck, /workspaces/);
  assert.match(pkg.scripts.build, /@tp\/web/);
  assert.match(pkg.scripts.server, /@tp\/adapter-browser/);
  assert.ok(pkg.workspaces.includes('packages/adapters/*'));
  assert.equal(pkg.scripts.worker, undefined);
  assert.equal(pkg.scripts.adapter, undefined);

  const graph = await readFile('packages/web/src/features/BehaviorTreeGraph.tsx', 'utf8');
  assert.match(graph, /@xyflow\/react/);
  assert.match(graph, /layoutBehaviorTree/);
  assert.match(graph, /pathClass/);
  assert.match(graph, /edgeClass/);
  const runTree = await readFile('packages/web/src/features/RunTreeView.tsx', 'utf8');
  assert.match(runTree, /mode="run"/);
  assert.match(runTree, /fitViewKey=\{run\.id\}/);
  assert.match(runTree, /runningAncestors/);
  assert.match(await readFile('packages/web/src/features/BehaviorTreeBuilder.tsx', 'utf8'), /BehaviorTreeGraph/);
  assert.match(await readFile('packages/contract/src/case-document.ts', 'utf8'), /zod/);
  assert.match(await readFile('packages/server/src/definition.ts', 'utf8'), /validateCaseCatalog/);
  assert.match(await readFile('packages/server/src/worker-pool.ts', 'utf8'), /node:worker_threads/);
  assert.match(await readFile('packages/server/src/worker-thread.ts', 'utf8'), /createSession/);
});

test('behavior tree editor exposes usable structural edits', async () => {
  const graph = await readFile('packages/web/src/features/BehaviorTreeGraph.tsx', 'utf8');
  const app = await readFile('packages/web/src/App.tsx', 'utf8');
  const builder = await readFile('packages/web/src/features/BuilderPage.tsx', 'utf8');

  assert.match(graph, /Handle/);
  assert.match(graph, /data-testid="bt-node"/);
  assert.match(graph, /data-testid="bt-slot"/);
  assert.match(graph, /data-bt-slot-mode/);
  assert.match(graph, /then \$/);
  assert.doesNotMatch(graph, /node-insert-type/);
  assert.doesNotMatch(app, /onClick=\{\(\) => addNode\(type\)\}/);
  assert.match(graph, /nodesDraggable=\{false\}/);
  assert.match(graph, /nodesConnectable=\{false\}/);
  assert.doesNotMatch(app, /data-testid="worker-id"/);
  assert.doesNotMatch(app, /body: \{ caseId, workerId \}/);
  assert.match(app, /listAdapters/);
  assert.match(builder, /data-testid="capability-palette"/);
  assert.match(builder, /data-capability=\{capability\.key\}/);
  assert.match(app, /listWorkers/);
  assert.doesNotMatch(app, /body: \{ caseId, workerId \}/);
});

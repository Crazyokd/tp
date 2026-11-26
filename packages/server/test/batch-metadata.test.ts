import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunTree, type BatchMetadata, type Run } from '@tp/contract';
import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { createPlatform } from '../src/platform.ts';
import { manifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const definition = caseDef({ type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} });
const metadata: BatchMetadata = {
  name: '定位回归',
  description: '验证拒绝与恢复',
  trigger: { kind: 'ci', pipelineUrl: 'https://git.example/pipelines/1' },
  selection: { kind: 'group', groupId: 'old-group', groupName: '旧发布组' },
};

async function setup(dir: string) {
  const registry = createAdapterRegistry();
  registry.register(manifest);
  const file = join(dir, 'db.json');
  const platform = await createPlatform(file, { registry });
  const alpha = await platform.createCase({ name: 'Alpha', description: 'alpha', definition });
  const beta = await platform.createCase({ name: 'Beta', description: 'beta', definition });
  return { file, platform, alpha, beta };
}

test('Batch freezes server-derived Group origin and isolates returned metadata from storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-meta-'));
  try {
    const { platform, file, alpha, beta } = await setup(dir);
    const group = await platform.createGroup({ name: '发布回归', caseIds: [alpha.id, beta.id] });
    const batch = await platform.createBatch({
      groupId: group.id,
      trigger: metadata.trigger,
      name: metadata.name,
      description: metadata.description,
    });
    assert.equal(batch.name, metadata.name);
    assert.equal(batch.description, metadata.description);
    assert.deepEqual(batch.trigger, metadata.trigger);
    assert.deepEqual(batch.selection, { kind: 'group', groupId: group.id, groupName: '发布回归' });
    await platform.updateGroup(group.id, { name: 'changed', caseIds: [alpha.id] });
    await platform.deleteGroup(group.id);
    assert.equal(batch.trigger.kind, 'ci');
    if (batch.trigger.kind === 'ci') batch.trigger.pipelineUrl = 'https://changed.example/';
    if (batch.selection.kind === 'group') batch.selection.groupName = 'changed response';
    const saved = await platform.getBatch(batch.id);
    assert.deepEqual(saved.trigger, metadata.trigger);
    assert.deepEqual(saved.selection, { kind: 'group', groupId: group.id, groupName: '发布回归' });
    await platform.cancelBatch(batch.id, () => {});
    const restarted = await createPlatform(file);
    assert.deepEqual((await restarted.getBatch(batch.id)).selection, saved.selection);
    assert.equal((await restarted.listBatches()).items[0]!.name, metadata.name);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Batch generates human names for single, multiple and Group selection at creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-meta-'));
  try {
    const { platform, alpha, beta } = await setup(dir);
    const one = await platform.createBatch({ caseIds: [alpha.id], trigger: { kind: 'web' } });
    assert.equal(one.name, 'Alpha');
    assert.equal(one.description, '');
    assert.deepEqual(one.selection, { kind: 'cases' });
    const many = await platform.createBatch({ caseIds: [alpha.id, beta.id], trigger: { kind: 'mcp' } });
    assert.equal(many.name, '2 个 Case');
    const group = await platform.createGroup({ name: '发布回归', caseIds: [alpha.id] });
    const grouped = await platform.createBatch({ groupId: group.id, trigger: { kind: 'web' } });
    assert.equal(grouped.name, '发布回归');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Batch import preserves metadata without requiring its original Group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tp-meta-'));
  try {
    const file = join(dir, 'db.json');
    const platform = await createPlatform(file);
    const now = '2026-11-18T00:00:00.000Z';
    const run: Run = {
      id: 'run',
      batchId: 'batch',
      caseId: 'missing-case',
      status: 'passed',
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      revision: 0,
      tree: createRunTree(definition),
      artifacts: [],
    };
    const imported = await platform.importBatch({ ...metadata, runs: [run], files: [] });
    assert.equal(imported.name, metadata.name);
    assert.equal(imported.description, metadata.description);
    assert.deepEqual(imported.selection, metadata.selection);
    assert.deepEqual(imported.trigger, metadata.trigger);
    const restarted = await createPlatform(file);
    assert.deepEqual(await restarted.getBatch(imported.id), imported);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    for (const key of ['name', 'description', 'trigger', 'selection']) {
      const old = structuredClone(stored);
      delete old.batches[0][key];
      const path = join(dir, `missing-${key}.json`);
      await writeFile(path, JSON.stringify(old));
      await assert.rejects(() => createPlatform(path));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

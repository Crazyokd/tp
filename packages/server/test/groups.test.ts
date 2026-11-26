import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAdapterRegistry } from '../src/adapter-registry.ts';
import { createPlatform } from '../src/platform.ts';
import { createRunQueue } from '../src/run-queue.ts';
import { manifest } from './fixtures/test-adapter.ts';
import { caseDef } from './case-def.ts';

const definition = caseDef({ type: 'Action', adapter: 'test', actor: 'robot', capability: 'test.pass', ports: {} });

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'tp-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = createAdapterRegistry();
  registry.register(manifest);
  const queue = createRunQueue();
  const file = join(dir, 'tp.json');
  const platform = await createPlatform(file, { registry, runQueue: queue });
  const shared = await platform.createCase({ name: 'shared', description: 'shared', definition });
  return { platform, shared, queue, file, registry };
}

test('two groups reference one Case and snapshot membership at enqueue', async (t) => {
  const { platform, shared, queue } = await setup(t);
  const extra = await platform.createCase({ name: 'extra', description: 'extra', definition });
  const wide = await platform.createGroup({ name: 'inttest', caseIds: [shared.id, extra.id] });
  const narrow = await platform.createGroup({ name: 'http', caseIds: [shared.id] });
  const first = (await platform.createBatch({ trigger: { kind: 'web' }, groupId: wide.id })).runs;
  const second = (await platform.createBatch({ trigger: { kind: 'web' }, groupId: narrow.id })).runs;
  assert.deepEqual(
    first.map((run) => run.caseId),
    [extra.id, shared.id],
  );
  assert.equal(new Set(first.map((run) => run.batchId)).size, 1);
  assert.equal(second[0]?.caseId, shared.id);
  assert.notEqual(second[0]?.batchId, first[0]?.batchId);
  await platform.updateGroup(wide.id, { name: 'inttest', caseIds: [extra.id] });
  assert.deepEqual(queue.get(first[1]!.id).definition, definition);
  assert.equal((await platform.listCases()).length, 2);
  assert.equal((await platform.createBatch({ trigger: { kind: 'web' }, groupId: wide.id })).runs.length, 1);
});

test('Group writes reject missing/duplicate Case ids, duplicate names and invalid fields', async (t) => {
  const { platform, shared } = await setup(t);
  await assert.rejects(() => platform.createGroup({ name: 'bad', caseIds: ['missing'] }), /case.*not found/);
  await assert.rejects(() => platform.createGroup({ name: 'bad', caseIds: [shared.id, shared.id] }), /duplicate/i);
  await assert.rejects(() => platform.createGroup({ name: 'bad', caseIds: [], extra: true }));
  const group = await platform.createGroup({ name: 'suite', caseIds: [shared.id] });
  await assert.rejects(() => platform.createGroup({ name: 'suite', caseIds: [] }), /already exists/);
  await assert.rejects(() => platform.updateGroup(group.id, { name: 'suite', caseIds: ['missing'] }));
  assert.deepEqual((await platform.getGroup(group.id)).caseIds, [shared.id]);
  const empty = await platform.createGroup({ name: 'empty', caseIds: [] });
  await assert.rejects(() => platform.createBatch({ trigger: { kind: 'web' }, groupId: empty.id }), /no cases/);
  await assert.rejects(
    () => platform.createBatch({ trigger: { kind: 'web' }, groupId: 'missing' }),
    /group.*not found/,
  );
});

test('referenced Case deletion fails, Group deletion keeps the Case and existing Runs', async (t) => {
  const { platform, shared } = await setup(t);
  const group = await platform.createGroup({ name: 'suite', caseIds: [shared.id] });
  await assert.rejects(() => platform.deleteCase(shared.id), /referenced.*suite/);
  const [run] = (await platform.createBatch({ trigger: { kind: 'web' }, groupId: group.id })).runs;
  await platform.deleteGroup(group.id);
  assert.equal((await platform.getCase(shared.id)).id, shared.id);
  assert.equal((await platform.getRun(run!.id)).caseId, shared.id);
  await assert.rejects(() => platform.deleteCase(shared.id), /live runs/);
  await platform.cancelRun(run!.id);
  await platform.deleteCase(shared.id);
  assert.deepEqual(await platform.listCases(), []);
});

test('Group relationships persist and failed persistence rolls back membership', async (t) => {
  const { platform, shared, file, registry } = await setup(t);
  const group = await platform.createGroup({ name: 'suite', caseIds: [shared.id] });
  const reopened = await createPlatform(file, { registry });
  assert.deepEqual(await reopened.getGroup(group.id), group);
  assert.equal('group' in (await reopened.getCase(shared.id)), false);
  await rm(file);
  await mkdir(file);
  await assert.rejects(() => platform.updateGroup(group.id, { name: 'changed', caseIds: [] }));
  assert.deepEqual(await platform.getGroup(group.id), group);
  await assert.rejects(() => platform.deleteGroup(group.id));
  assert.equal((await platform.listGroups()).length, 1);
});

test('persisted dangling references fail closed', async (t) => {
  const { platform, shared, file, registry } = await setup(t);
  await platform.createGroup({ name: 'suite', caseIds: [shared.id] });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.cases = [];
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => createPlatform(file, { registry }), /case.*not found/);
});

test('persisted duplicate Group IDs and names fail closed', async (t) => {
  const { platform, shared, file, registry } = await setup(t);
  const group = await platform.createGroup({ name: 'suite', caseIds: [shared.id] });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.groups.push({ ...group, name: 'another' });
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => createPlatform(file, { registry }), /duplicate group id/);
  stored.groups[1] = { ...group, id: 'other-id' };
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => createPlatform(file, { registry }), /already exists/);
});

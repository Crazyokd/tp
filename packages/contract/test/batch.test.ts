import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as contract from '../src/index.ts';

test('batch creation selects one or many Case ids or one Group id', () => {
  const schema = contract.httpBatchCreateSchema;
  for (const input of [{ caseIds: ['one'] }, { caseIds: ['one', 'two'] }, { groupId: 'group' }]) {
    const request = { ...input, trigger: { kind: 'web' } };
    assert.deepEqual(schema.parse(request), request);
  }
  for (const input of [
    {},
    { caseIds: [] },
    { caseIds: ['one', 'one'] },
    { caseIds: ['one'], groupId: 'g' },
    { caseId: 'one' },
    { group: 'g' },
  ]) {
    assert.equal(schema.safeParse({ ...input, trigger: { kind: 'web' } }).success, false);
  }
  assert.equal(
    schema.safeParse({ trigger: { kind: 'web' }, caseIds: ['one'], blackboard: { bad: Infinity } }).success,
    false,
  );
});

test('native batch routes replace standalone Run creation and import', () => {
  assert.equal(contract.matchOperation('POST', '/api/batches')?.id, 'createBatch');
  assert.equal(contract.matchOperation('GET', '/api/batches')?.id, 'listBatches');
  assert.equal(contract.matchOperation('GET', '/api/batches/b')?.id, 'getBatch');
  assert.equal(contract.matchOperation('POST', '/api/batches/b/cancel')?.id, 'cancelBatch');
  assert.equal(contract.matchOperation('POST', '/api/batches/import')?.id, 'importBatch');
  assert.equal(contract.matchOperation('POST', '/api/runs'), undefined);
  assert.equal(contract.matchOperation('POST', '/api/runs/import'), undefined);
  assert.equal(contract.matchOperation('GET', '/api/runs/r/events')?.id, 'watchRun');
});

test('Batch import rejects Run ids that could escape a resource directory', () => {
  const run = {
    id: 'safe-run',
    batchId: 'batch',
    caseId: 'absent',
    status: 'passed',
    createdAt: '2026-11-18T00:00:00.000Z',
    startedAt: null,
    finishedAt: '2026-11-18T00:00:00.000Z',
    revision: 0,
    tree: {
      main: 'Main',
      trees: {
        Main: {
          type: 'Action',
          adapter: 'test',
          actor: 'robot',
          capability: 'test.pass',
          ports: {},
          status: 'pending',
          attempts: [],
        },
      },
    },
    artifacts: [],
  };
  assert.equal(
    contract.httpBatchImportSchema.safeParse({
      name: 'Imported Batch',
      description: '',
      trigger: { kind: 'web' },
      selection: { kind: 'cases' },
      runs: [run],
      files: [],
    }).success,
    true,
  );
  for (const id of ['.', '..', '../outside', 'nested/run', 'nested\\run', '\0']) {
    assert.equal(
      contract.httpBatchImportSchema.safeParse({
        name: 'Imported Batch',
        description: '',
        trigger: { kind: 'web' },
        selection: { kind: 'cases' },
        runs: [{ ...run, id }],
        files: [],
      }).success,
      false,
      id,
    );
  }
});

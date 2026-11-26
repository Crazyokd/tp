import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as contract from '../src/index.ts';

test('Batch creation requires an explicit valid trigger and accepts naming fields', () => {
  assert.equal(contract.httpBatchCreateSchema.safeParse({ caseIds: ['one'] }).success, false);
  for (const trigger of [
    { kind: 'web' },
    { kind: 'mcp' },
    { kind: 'ci' },
    { kind: 'ci', pipelineUrl: 'https://git.example/jobs/1' },
  ]) {
    const value = { caseIds: ['one'], trigger, name: '定位回归', description: '验证定位拒绝' };
    assert.deepEqual(contract.httpBatchCreateSchema.parse(value), value);
  }
  for (const trigger of [
    { kind: 'api' },
    { kind: 'web', pipelineUrl: 'https://git.example/jobs/1' },
    { kind: 'ci', pipelineUrl: 'javascript:alert(1)' },
    { kind: 'ci', pipelineUrl: 'file:///etc/passwd' },
  ]) {
    assert.equal(contract.httpBatchCreateSchema.safeParse({ caseIds: ['one'], trigger }).success, false);
  }
  assert.equal(
    contract.httpBatchCreateSchema.safeParse({ caseIds: ['one'], trigger: { kind: 'web' }, name: '  ' }).success,
    false,
  );
  assert.equal(
    contract.httpBatchCreateSchema.safeParse({
      groupId: 'g',
      trigger: { kind: 'web' },
      selection: { kind: 'group', groupId: 'g', groupName: 'forged' },
    }).success,
    false,
  );
});

test('Batch metadata is strict and requires a complete Group snapshot', () => {
  const schema = contract.httpBatchMetadataSchema;
  const value = {
    name: '回归',
    description: '',
    trigger: { kind: 'ci', pipelineUrl: 'http://git.example/pipelines/1' },
    selection: { kind: 'group', groupId: 'g', groupName: '发布验收' },
  };
  assert.deepEqual(schema.parse(value), value);
  for (const bad of [
    { ...value, name: undefined },
    { ...value, description: undefined },
    { ...value, trigger: undefined },
    { ...value, selection: undefined },
    { ...value, selection: { kind: 'group', groupId: 'g' } },
    { ...value, selection: { kind: 'cases', groupId: 'g' } },
    { ...value, extra: true },
  ]) {
    assert.equal(schema.safeParse(bad).success, false);
  }
});

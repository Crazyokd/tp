import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRunArtifactStore } from '../src/run-artifacts.ts';

test('recordArtifact writes sidecar, rejects escape and duplicate path, allows byte change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tp-art-'));
  const events: { revision: number; artifact: { id: string } }[] = [];
  const store = createRunArtifactStore({
    resourceRoot: root,
    nextRevision: (() => {
      let revision = 0;
      return () => ++revision;
    })(),
    onRecord: (event) => events.push(event),
  });
  await mkdir(join(root, 'shots'), { recursive: true });
  await writeFile(join(root, 'shots', 'a.txt'), 'one');
  const first = store.recordArtifact({ name: 'A', mediaType: 'text/plain', path: 'shots/a.txt' });
  assert.equal(typeof first.id, 'string');
  assert.equal(events[0]?.revision, 1);
  await writeFile(join(root, 'shots', 'a.txt'), 'two');
  const sidecar = JSON.parse(await readFile(join(root, '.tp-artifacts.json'), 'utf8')) as {
    items: { path: string; id: string }[];
  };
  assert.equal(sidecar.items[0]?.path, 'shots/a.txt');
  assert.equal(sidecar.items[0]?.id, first.id);
  assert.throws(() => store.recordArtifact({ name: 'A', mediaType: 'text/plain', path: 'shots/a.txt' }), /path/);
  assert.throws(() => store.recordArtifact({ name: 'X', mediaType: 'text/plain', path: '../x' }), /path/);
  assert.throws(() => store.recordArtifact({ name: 'X', mediaType: 'text/plain', path: 'missing.txt' }), /exist/);
});

test('purgeUnregistered deletes extras and keeps recorded files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tp-art-purge-'));
  const store = createRunArtifactStore({
    resourceRoot: root,
    nextRevision: () => 1,
    onRecord: () => undefined,
  });
  await writeFile(join(root, 'keep.txt'), 'keep');
  await writeFile(join(root, 'drop.txt'), 'drop');
  store.recordArtifact({ name: 'keep', mediaType: 'text/plain', path: 'keep.txt' });
  await store.purgeUnregistered();
  await assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(root, 'drop.txt')), /ENOENT/);
});

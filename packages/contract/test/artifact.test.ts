import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendRunArtifact, resolveRunArtifactPath } from '../src/artifact.ts';
import type { Artifact } from '../src/types.ts';

test('resolveRunArtifactPath accepts nested relative paths', () => {
  assert.equal(resolveRunArtifactPath('demo/robot/recording.mp4'), 'demo/robot/recording.mp4');
});

test('resolveRunArtifactPath rejects empty, absolute, and escaping paths', () => {
  assert.throws(() => resolveRunArtifactPath(''), /artifact path/);
  assert.throws(() => resolveRunArtifactPath('/tmp/x'), /artifact path/);
  assert.throws(() => resolveRunArtifactPath('..'), /artifact path/);
  assert.throws(() => resolveRunArtifactPath('../x'), /artifact path/);
  assert.throws(() => resolveRunArtifactPath('a/../../x'), /artifact path/);
});

test('appendRunArtifact appends and bumps revision', () => {
  const artifact: Artifact = { id: 'art-1', name: 'n', mediaType: 'text/plain' };
  const next = appendRunArtifact({ revision: 3, artifacts: [] }, { revision: 4, artifact });
  assert.equal(next.revision, 4);
  assert.deepEqual(next.artifacts, [artifact]);
});

test('appendRunArtifact rejects wrong revision, duplicate id, and duplicate apply', () => {
  const artifact: Artifact = { id: 'art-1', name: 'n', mediaType: 'text/plain' };
  const snapshot = { revision: 1, artifacts: [artifact] };
  assert.throws(() => appendRunArtifact(snapshot, { revision: 1, artifact: { ...artifact, id: 'art-2' } }), /revision/);
  assert.throws(() => appendRunArtifact(snapshot, { revision: 2, artifact }), /artifact/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightJson } from '../src/domain/json-highlight.ts';

test('highlightJson covers stringify output and tags keys strings and numbers', () => {
  const text = JSON.stringify({ main: 'Main', n: 1, ok: true }, null, 2);
  const spans = highlightJson(text);
  assert.equal(spans.map((span) => span.text).join(''), text);
  assert.deepEqual(
    spans.filter((span) => span.kind === 'key').map((span) => span.text),
    ['"main"', '"n"', '"ok"'],
  );
  assert.deepEqual(
    spans.filter((span) => span.kind === 'string').map((span) => span.text),
    ['"Main"'],
  );
  assert.deepEqual(
    spans.filter((span) => span.kind === 'number').map((span) => span.text),
    ['1'],
  );
  assert.deepEqual(
    spans.filter((span) => span.kind === 'punct').map((span) => span.text),
    ['{', ':', ',', ':', ',', ':', '}'],
  );
  assert.deepEqual(
    spans.filter((span) => span.kind === 'other').map((span) => span.text),
    ['\n  ', ' ', '\n  ', ' ', '\n  ', ' ', 'true', '\n'],
  );
});

test('highlightJson keeps escaped quotes inside string values', () => {
  const text = JSON.stringify({ note: 'say "hi"' }, null, 2);
  const spans = highlightJson(text);
  assert.equal(spans.map((span) => span.text).join(''), text);
  assert.deepEqual(
    spans.filter((span) => span.kind === 'string').map((span) => span.text),
    ['"say \\"hi\\""'],
  );
});

test('highlightJson throws on text that is not JSON', () => {
  assert.throws(() => highlightJson('{'), /highlightJson/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertPreconditionSyntax, PreconditionSyntaxError } from '../src/precondition.ts';

test('accepts a closed comparison', () => {
  assert.doesNotThrow(() => assertPreconditionSyntax('{ready} == true'));
});

test('accepts a bare blackboard ref', () => {
  assert.doesNotThrow(() => assertPreconditionSyntax('{ready}'));
});

test('rejects garbage', () => {
  assert.throws(() => assertPreconditionSyntax('???'), PreconditionSyntaxError);
});

test('rejects an empty string', () => {
  assert.throws(() => assertPreconditionSyntax(''), PreconditionSyntaxError);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';

import { errorResponse, HttpError } from '../src/http-error.ts';

test('HttpError maps to the status of its code', () => {
  const result = errorResponse(new HttpError('not_found', 'gone'));
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { code: 'not_found', message: 'gone' });
});

test('unexpected errors map to invalid 400', () => {
  const result = errorResponse(new Error('boom'));
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { code: 'invalid', message: 'boom' });
});

test('ZodError maps to invalid 400', () => {
  const result = errorResponse(new ZodError([]));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid');
});

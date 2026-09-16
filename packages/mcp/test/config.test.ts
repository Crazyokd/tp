import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBaseUrl } from '../src/config.ts';

test('defaults to local server when TP_BASE_URL is unset', () => {
  assert.equal(resolveBaseUrl({}), 'http://127.0.0.1:3000');
});

test('uses TP_BASE_URL when it is an absolute http URL', () => {
  assert.equal(resolveBaseUrl({ TP_BASE_URL: 'http://192.168.1.4:4000' }), 'http://192.168.1.4:4000');
});

test('uses TP_BASE_URL when it is an absolute https URL', () => {
  assert.equal(resolveBaseUrl({ TP_BASE_URL: 'https://tp.example.com' }), 'https://tp.example.com');
});

test('rejects empty TP_BASE_URL', () => {
  assert.throws(() => resolveBaseUrl({ TP_BASE_URL: '' }), /TP_BASE_URL/);
});

test('rejects a relative TP_BASE_URL', () => {
  assert.throws(() => resolveBaseUrl({ TP_BASE_URL: '/api' }), /TP_BASE_URL/);
});

test('rejects a non-http TP_BASE_URL', () => {
  assert.throws(() => resolveBaseUrl({ TP_BASE_URL: 'ftp://127.0.0.1:3000' }), /TP_BASE_URL/);
});

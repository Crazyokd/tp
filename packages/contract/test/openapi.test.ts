import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operations, matchOperation } from '../src/http-operations.ts';
import { generateOpenApi } from '../src/openapi.ts';

test('every public resource is registered once', () => {
  const keys = operations.map((op) => `${op.method} ${op.path}`);
  assert.deepEqual(new Set(keys).size, keys.length);
  for (const needed of [
    'GET /api/adapters',
    'GET /api/adapters/:id',
    'GET /api/cases',
    'POST /api/cases',
    'GET /api/cases/:id',
    'PUT /api/cases/:id',
    'DELETE /api/cases/:id',
    'GET /api/runs',
    'GET /api/batches',
    'POST /api/batches',
    'GET /api/batches/:id',
    'POST /api/batches/:id/cancel',
    'GET /api/runs/:id/events',
    'GET /api/runs/:id/artifacts/:artifactId',
    'POST /api/runs/:id/cancel',
    'GET /api/workers',
    'GET /api/workers/:id',
    'GET /api/metrics',
  ]) {
    assert.ok(keys.includes(needed), needed);
  }
});

test('matchOperation parses /api/adapters/demo', () => {
  const hit = matchOperation('GET', '/api/adapters/demo');
  assert.equal(hit?.id, 'getAdapter');
  assert.equal(hit?.params.id, 'demo');
  assert.equal(matchOperation('GET', '/api/metrics')?.id, 'getMetrics');
  assert.equal(matchOperation('GET', '/api/nope'), undefined);
});

test('openapi lists the same operations', () => {
  const doc = generateOpenApi();
  assert.equal(doc.openapi.startsWith('3.'), true);
  assert.ok(doc.paths['/api/runs']);
  assert.deepEqual(
    new Set(Object.keys(doc.paths ?? {})),
    new Set(operations.map((operation) => operation.path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}'))),
  );
});

test('published Batch creation schema requires exactly one selector and unique Case ids', () => {
  const document = generateOpenApi();
  const operation = document.paths['/api/batches']!.post as {
    requestBody: {
      content: {
        'application/json': { schema: { oneOf?: unknown; properties: { caseIds: { uniqueItems?: boolean } } } };
      };
    };
  };
  const schema = operation.requestBody.content['application/json'].schema;
  assert.deepEqual(schema.oneOf, [{ required: ['caseIds'] }, { required: ['groupId'] }]);
  assert.equal(schema.properties.caseIds.uniqueItems, true);
});

test('openapi documents getRunArtifact as octet-stream', () => {
  const doc = generateOpenApi();
  const operation = doc.paths['/api/runs/{id}/artifacts/{artifactId}']?.get as
    { responses?: Record<string, { description?: string; content?: Record<string, unknown> }> } | undefined;
  const success = operation?.responses?.['200'];
  assert.ok(success?.content?.['application/octet-stream']);
  assert.notEqual(success?.description, 'No Content');
});

test('openapi documents watchRun as event-stream and does not register getRun', () => {
  const doc = generateOpenApi();
  assert.equal(
    operations.some((item) => item.id === 'getRun'),
    false,
  );
  const operation = doc.paths['/api/runs/{id}/events']?.get as
    | {
        operationId?: string;
        parameters?: { name: string; in: string }[];
        responses?: Record<string, { content?: Record<string, unknown> }>;
      }
    | undefined;
  assert.equal(operation?.operationId, 'watchRun');
  assert.ok(operation?.responses?.['200']?.content?.['text/event-stream']);
  assert.ok(operation?.parameters?.some((item) => item.name === 'Last-Event-ID' && item.in === 'header'));
});

test('openapi groups operations by resource tag', () => {
  const doc = generateOpenApi();
  assert.deepEqual(
    doc.tags.map((tag) => tag.name),
    ['Adapters', 'Cases', 'Groups', 'Runs', 'Batches', 'Workers', 'Ops'],
  );
  assert.deepEqual(operationTags(doc, '/api/adapters', 'get'), ['Adapters']);
  assert.deepEqual(operationTags(doc, '/api/cases', 'post'), ['Cases']);
  assert.deepEqual(operationTags(doc, '/api/runs', 'get'), ['Runs']);
  assert.deepEqual(operationTags(doc, '/api/runs/{id}/cancel', 'post'), ['Runs']);
  assert.deepEqual(operationTags(doc, '/api/workers', 'get'), ['Workers']);
  assert.deepEqual(operationTags(doc, '/api/metrics', 'get'), ['Ops']);
  for (const operation of operations) {
    assert.equal(operation.tag, expectedTag(operation.path), operation.id);
  }
});

function operationTags(doc: ReturnType<typeof generateOpenApi>, path: string, method: string): string[] {
  const operation = doc.paths[path]?.[method] as { tags: string[] } | undefined;
  if (!operation) throw new Error(`missing OpenAPI operation ${method.toUpperCase()} ${path}`);
  return operation.tags;
}

function expectedTag(path: string): string {
  if (path.startsWith('/api/adapters')) return 'Adapters';
  if (path.startsWith('/api/cases')) return 'Cases';
  if (path.startsWith('/api/groups')) return 'Groups';
  if (path.startsWith('/api/batches')) return 'Batches';
  if (path.startsWith('/api/runs')) return 'Runs';
  if (path.startsWith('/api/workers')) return 'Workers';
  if (path.startsWith('/api/metrics')) return 'Ops';
  throw new Error(`unclassified path ${path}`);
}

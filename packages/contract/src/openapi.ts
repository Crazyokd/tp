import { z } from 'zod';

import { apiErrorSchema } from './http-error.ts';
import { operations, type HttpOperation } from './http-operations.ts';

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
};

function toOpenApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'inline' }) as Record<string, unknown>;
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParameters(schema: z.ZodType): Record<string, unknown>[] {
  const documented = jsonSchema(schema);
  const properties = documented.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(documented.required) ? documented.required : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, property]) => {
    const parameter: Record<string, unknown> = {
      name,
      in: 'query',
      required: required.has(name),
      schema: property,
    };
    if (name === 'status') {
      parameter.style = 'form';
      parameter.explode = true;
    }
    return parameter;
  });
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: jsonSchema(apiErrorSchema),
      },
    },
  };
}

function successResponse(operation: HttpOperation): Record<string, unknown> {
  if (!operation.response && operation.successStatus === 204) {
    return { description: 'No Content' };
  }
  if (!operation.response && operation.successStatus === 200) {
    return {
      description: 'OK',
      content: {
        'application/octet-stream': {},
      },
    };
  }
  if (!operation.response) {
    throw new Error(`null response requires successStatus 200 or 204, got ${operation.successStatus}`);
  }
  return {
    description: 'OK',
    content: {
      'application/json': {
        schema: jsonSchema(operation.response),
      },
    },
  };
}

function operationObject(operation: HttpOperation): Record<string, unknown> {
  const parameters = [...pathParameters(operation.path), ...queryParameters(operation.query)];
  const documented: Record<string, unknown> = {
    tags: [operation.tag],
    operationId: operation.id,
    parameters,
    responses: {
      [String(operation.successStatus)]: successResponse(operation),
      '400': errorResponse('invalid'),
      '403': errorResponse('forbidden'),
      '404': errorResponse('not_found'),
      '409': errorResponse('conflict'),
    },
  };
  if (operation.body) {
    documented.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: jsonSchema(operation.body),
        },
      },
    };
  }
  return documented;
}

export function generateOpenApi(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const path = toOpenApiPath(operation.path);
    const item = paths[path] ?? {};
    item[operation.method.toLowerCase()] = operationObject(operation);
    paths[path] = item;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'TP HTTP API',
      version: '0.1.0',
    },
    tags: [...new Set(operations.map((operation) => operation.tag))].map((name) => ({ name })),
    paths,
  };
}

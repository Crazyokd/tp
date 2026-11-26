import type { AdapterManifest, CapabilityDefinition, PortDefinition } from '@tp/contract/adapter';
import type { JsonObject } from '@tp/contract';

const errorSchema = { type: 'string' } as const satisfies JsonObject;
const nameSchema = { type: 'string', minLength: 1 } as const satisfies JsonObject;
const booleanSchema = { type: 'boolean' } as const satisfies JsonObject;
const ratioSchema = { type: 'number', minimum: 0, maximum: 1 } as const satisfies JsonObject;
const statusSchema = { type: 'integer', minimum: 100, maximum: 599 } as const satisfies JsonObject;
const countSchema = { type: 'integer', minimum: 0 } as const satisfies JsonObject;
const timesSchema = { type: 'integer', minimum: 1 } as const satisfies JsonObject;
const viewportSchema = { type: 'integer', minimum: 1 } as const satisfies JsonObject;
const objectSchema = { type: 'object', properties: {}, additionalProperties: true } as const satisfies JsonObject;
const methodSchema = {
  type: 'string',
  enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
} as const satisfies JsonObject;
const assertionSchema = {
  type: 'string',
  enum: ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'value', 'attribute', 'count'],
} as const satisfies JsonObject;
const mouseActionSchema = {
  type: 'string',
  enum: ['move', 'down', 'up', 'drag'],
} as const satisfies JsonObject;
const routeActionSchema = {
  type: 'string',
  enum: ['abort', 'fulfill', 'hold'],
} as const satisfies JsonObject;
const releaseActionSchema = {
  type: 'string',
  enum: ['fulfill', 'abort', 'continue'],
} as const satisfies JsonObject;

const errorPort = {
  name: 'error',
  direction: 'out',
  schema: errorSchema,
  required: false,
} as const satisfies PortDefinition;

const selectorPort = {
  name: 'selector',
  direction: 'in',
  schema: nameSchema,
  required: true,
} as const satisfies PortDefinition;

const urlOutPort = {
  name: 'url',
  direction: 'out',
  schema: nameSchema,
  required: false,
} as const satisfies PortDefinition;

const capabilities: CapabilityDefinition[] = [
  {
    key: 'browser.watch_requests',
    kind: 'Action',
    label: '观察页面请求',
    ports: [
      { name: 'url', direction: 'in', schema: nameSchema, required: true },
      { name: 'method', direction: 'in', schema: methodSchema, required: true },
      errorPort,
    ],
  },
  {
    key: 'browser.expect_requests',
    kind: 'Condition',
    label: '核对页面请求',
    ports: [
      { name: 'url', direction: 'in', schema: nameSchema, required: true },
      { name: 'method', direction: 'in', schema: methodSchema, required: true },
      { name: 'count', direction: 'inout', schema: countSchema, required: true },
      { name: 'expectedBody', direction: 'in', schema: objectSchema, required: false },
      { name: 'previousBody', direction: 'in', schema: objectSchema, required: false },
      {
        name: 'changedFields',
        direction: 'in',
        schema: { type: 'array', minItems: 1, uniqueItems: true, items: nameSchema },
        required: false,
      },
      { name: 'body', direction: 'out', schema: objectSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.goto',
    kind: 'Action',
    label: '打开页面',
    ports: [{ name: 'url', direction: 'inout', schema: nameSchema, required: true }, errorPort],
  },
  {
    key: 'browser.click',
    kind: 'Action',
    label: '点击元素',
    ports: [
      selectorPort,
      { name: 'waitResponseUrl', direction: 'in', schema: nameSchema, required: false },
      { name: 'waitResponseMethod', direction: 'in', schema: methodSchema, required: false },
      { name: 'waitResponseStatus', direction: 'in', schema: statusSchema, required: false },
      { name: 'waitResponseBody', direction: 'in', schema: objectSchema, required: false },
      { name: 'force', direction: 'in', schema: booleanSchema, required: false },
      { name: 'responseBody', direction: 'out', schema: objectSchema, required: false },
      { name: 'clicked', direction: 'out', schema: booleanSchema, required: false },
      { name: 'responseStatus', direction: 'out', schema: statusSchema, required: false },
      { name: 'responseUrl', direction: 'out', schema: nameSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.fill',
    kind: 'Action',
    label: '填写输入',
    ports: [
      selectorPort,
      { name: 'value', direction: 'in', schema: errorSchema, required: true },
      { name: 'filled', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.expect_text',
    kind: 'Condition',
    label: '断言可见文本',
    ports: [selectorPort, { name: 'text', direction: 'inout', schema: nameSchema, required: true }, errorPort],
  },
  {
    key: 'browser.screenshot',
    kind: 'Action',
    label: '截图',
    ports: [
      { name: 'name', direction: 'in', schema: nameSchema, required: true },
      { name: 'path', direction: 'out', schema: nameSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.canvas_probe',
    kind: 'Condition',
    label: '检查画布像素',
    ports: [
      selectorPort,
      { name: 'minimumWidth', direction: 'in', schema: countSchema, required: false },
      { name: 'minimumHeight', direction: 'in', schema: countSchema, required: false },
      { name: 'minimumOccupiedPixels', direction: 'in', schema: countSchema, required: false },
      { name: 'minimumCenterOccupiedPixels', direction: 'in', schema: countSchema, required: false },
      { name: 'previousHash', direction: 'in', schema: countSchema, required: false },
      { name: 'expectedHash', direction: 'in', schema: countSchema, required: false },
      { name: 'greaterThanOccupiedPixels', direction: 'in', schema: countSchema, required: false },
      { name: 'hash', direction: 'out', schema: countSchema, required: false },
      { name: 'occupiedPixels', direction: 'out', schema: countSchema, required: false },
      { name: 'centerOccupiedPixels', direction: 'out', schema: countSchema, required: false },
      { name: 'width', direction: 'out', schema: countSchema, required: false },
      { name: 'height', direction: 'out', schema: countSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.expect',
    kind: 'Condition',
    label: '断言元素状态',
    ports: [
      selectorPort,
      { name: 'assertion', direction: 'in', schema: assertionSchema, required: true },
      { name: 'expected', direction: 'in', schema: errorSchema, required: false },
      { name: 'attribute', direction: 'in', schema: nameSchema, required: false },
      { name: 'count', direction: 'in', schema: countSchema, required: false },
      { name: 'matched', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.expect_url',
    kind: 'Condition',
    label: '断言页面地址',
    ports: [
      { name: 'regex', direction: 'in', schema: nameSchema, required: true },
      urlOutPort,
      { name: 'capture', direction: 'out', schema: nameSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.reload',
    kind: 'Action',
    label: '刷新页面',
    ports: [urlOutPort, errorPort],
  },
  {
    key: 'browser.mouse',
    kind: 'Action',
    label: '鼠标操作',
    ports: [
      { name: 'action', direction: 'in', schema: mouseActionSchema, required: true },
      selectorPort,
      { name: 'xRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'yRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'toXRatio', direction: 'in', schema: ratioSchema, required: false },
      { name: 'toYRatio', direction: 'in', schema: ratioSchema, required: false },
      { name: 'steps', direction: 'in', schema: timesSchema, required: false },
      { name: 'done', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.touch_drag',
    kind: 'Action',
    label: '触屏拖动',
    ports: [
      selectorPort,
      { name: 'xRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'yRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'toXRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'toYRatio', direction: 'in', schema: ratioSchema, required: true },
      { name: 'steps', direction: 'in', schema: timesSchema, required: true },
      { name: 'done', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.route',
    kind: 'Action',
    label: '拦截请求',
    ports: [
      { name: 'url', direction: 'in', schema: nameSchema, required: true },
      { name: 'method', direction: 'in', schema: methodSchema, required: false },
      { name: 'action', direction: 'in', schema: routeActionSchema, required: true },
      { name: 'status', direction: 'in', schema: statusSchema, required: false },
      { name: 'body', direction: 'in', schema: errorSchema, required: false },
      { name: 'contentType', direction: 'in', schema: nameSchema, required: false },
      { name: 'times', direction: 'in', schema: timesSchema, required: false },
      { name: 'routed', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.unroute',
    kind: 'Action',
    label: '拆除拦截',
    ports: [
      { name: 'url', direction: 'in', schema: nameSchema, required: true },
      { name: 'unrouted', direction: 'out', schema: booleanSchema, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.release',
    kind: 'Action',
    label: '放行拦截',
    ports: [
      { name: 'url', direction: 'in', schema: nameSchema, required: true },
      { name: 'action', direction: 'in', schema: releaseActionSchema, required: true },
      { name: 'status', direction: 'in', schema: statusSchema, required: false },
      { name: 'body', direction: 'in', schema: errorSchema, required: false },
      { name: 'contentType', direction: 'in', schema: nameSchema, required: false },
      { name: 'expectedRequestText', direction: 'in', schema: nameSchema, required: false },
      { name: 'released', direction: 'out', schema: booleanSchema, required: false },
      { name: 'requestBody', direction: 'out', schema: errorSchema, required: false },
      errorPort,
    ],
  },
];

export const manifest = {
  id: 'browser',
  moduleEntry: '@tp/adapter-browser',
  capabilities,
  session: {
    ports: [
      { name: 'origin', direction: 'in', schema: nameSchema, required: true },
      { name: 'viewportWidth', direction: 'in', schema: viewportSchema, required: false },
      { name: 'viewportHeight', direction: 'in', schema: viewportSchema, required: false },
      { name: 'locale', direction: 'in', schema: nameSchema, required: false },
      { name: 'timezoneId', direction: 'in', schema: nameSchema, required: false },
      { name: 'initScript', direction: 'in', schema: nameSchema, required: false },
    ],
  },
} satisfies AdapterManifest;

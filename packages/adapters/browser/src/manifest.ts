import type { AdapterManifest, CapabilityDefinition, PortDefinition } from '@tp/contract/adapter';
import type { JsonObject } from '@tp/contract';

const errorSchema = { type: 'string' } as const satisfies JsonObject;
const nameSchema = { type: 'string', minLength: 1 } as const satisfies JsonObject;

const errorPort = {
  name: 'error',
  direction: 'out',
  schema: errorSchema,
  required: false,
} as const satisfies PortDefinition;

const capabilities: CapabilityDefinition[] = [
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
      { name: 'selector', direction: 'in', schema: nameSchema, required: true },
      { name: 'clicked', direction: 'out', schema: { type: 'boolean' }, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.fill',
    kind: 'Action',
    label: '填写输入',
    ports: [
      { name: 'selector', direction: 'in', schema: nameSchema, required: true },
      { name: 'value', direction: 'in', schema: errorSchema, required: true },
      { name: 'filled', direction: 'out', schema: { type: 'boolean' }, required: false },
      errorPort,
    ],
  },
  {
    key: 'browser.expect_text',
    kind: 'Condition',
    label: '断言可见文本',
    ports: [
      { name: 'selector', direction: 'in', schema: nameSchema, required: true },
      { name: 'text', direction: 'inout', schema: nameSchema, required: true },
      errorPort,
    ],
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
];

export const manifest = {
  id: 'browser',
  moduleEntry: '@tp/adapter-browser',
  capabilities,
} satisfies AdapterManifest;

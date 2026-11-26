import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TickResult } from '@tp/contract';
import type { AdapterManifest, AdapterModule } from '@tp/contract/adapter';

export const manifest = {
  id: 'seed',
  moduleEntry: import.meta.url,
  capabilities: [{ key: 'seed.ready', kind: 'Condition', label: 'Ready', ports: [] }],
  session: {
    ports: [
      { name: 'label', direction: 'in', schema: { type: 'string' }, required: true },
      { name: 'note', direction: 'in', schema: { type: 'string' }, required: false, default: 'fallback' },
    ],
  },
} satisfies AdapterManifest;

export const createSession: AdapterModule['createSession'] = async (context) => {
  await writeFile(
    join(context.resourceRoot, 'session.txt'),
    `${String(context.input.label)}\n${String(context.input.note)}`,
  );
  context.recordArtifact({ name: 'session', mediaType: 'text/plain', path: 'session.txt' });
  return {
    async tick(): Promise<TickResult> {
      return { status: 'SUCCESS' };
    },
    async halt() {
      return undefined;
    },
    async cleanup() {
      return undefined;
    },
  };
};

import type { AdapterManifest, AdapterModule } from '@tp/contract/adapter';

export const manifest: AdapterManifest = {
  id: 'second-test',
  moduleEntry: import.meta.url,
  capabilities: [
    {
      key: 'second-test.pass',
      kind: 'Action',
      label: 'Second pass',
      ports: [],
    },
  ],
};

export const createSession: AdapterModule['createSession'] = async () => ({
  async tick() {
    return { status: 'SUCCESS' };
  },
  async halt() {},
  async cleanup() {},
});

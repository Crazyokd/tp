import { isDeepStrictEqual } from 'node:util';

import { assertSupportedJsonSchema } from '@tp/contract';
import {
  adapterManifestSchema,
  type AdapterManifest,
  type CatalogCapability,
  type CapabilityDefinition,
} from '@tp/contract/adapter';

export function createAdapterRegistry() {
  const adapters = new Map<string, AdapterManifest>();

  return {
    register(input: unknown): AdapterManifest {
      const manifest = adapterManifestSchema.parse(input);
      const declared = new Set<string>();
      for (const capability of manifest.capabilities) {
        if (declared.has(capability.key)) {
          throw new Error(`capability ${capability.key} is declared more than once by adapter ${manifest.id}`);
        }
        declared.add(capability.key);
        const names = new Set<string>();
        for (const port of capability.ports) {
          if (names.has(port.name)) {
            throw new Error(`capability ${capability.key} declares port ${port.name} more than once`);
          }
          names.add(port.name);
          assertSupportedJsonSchema(port.schema, `${capability.key}.${port.name}.schema`);
        }
      }
      const existing = adapters.get(manifest.id);
      if (existing) {
        if (!isDeepStrictEqual(existing, manifest)) {
          throw new Error(`adapter ${manifest.id} is already registered with different content`);
        }
        return clone(existing);
      }

      const stored = clone(manifest);
      adapters.set(stored.id, stored);
      return clone(stored);
    },

    listAdapters(): AdapterManifest[] {
      return [...adapters.values()].map(clone);
    },

    listCapabilities(): CatalogCapability[] {
      return [...adapters.values()].flatMap((adapter) =>
        adapter.capabilities.map((capability) => ({ ...clone(capability), adapter: adapter.id })),
      );
    },

    getCapability(adapterId: string, key: string): CapabilityDefinition {
      const adapter = adapters.get(adapterId);
      const capability = adapter?.capabilities.find((candidate) => candidate.key === key);
      if (!capability) throw new Error(`capability ${key} is not registered on adapter ${adapterId}`);
      return clone(capability);
    },

    getAdapter(adapterId: string): AdapterManifest {
      const adapter = adapters.get(adapterId);
      if (!adapter) throw new Error(`adapter ${adapterId} is not registered`);
      return clone(adapter);
    },
  };
}

export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

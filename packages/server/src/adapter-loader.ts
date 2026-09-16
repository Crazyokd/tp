import { adapterManifestSchema } from '@tp/contract/adapter';
import type { AdapterRegistry } from './adapter-registry.ts';
import { logger } from './log.ts';
import type { ServerMetrics } from './metrics.ts';

const log = logger('adapter');

export function resolveAdapterModules(options?: { adapterModules?: readonly string[] }): string[] {
  if (options?.adapterModules) return [...options.adapterModules];
  return (process.env.TP_ADAPTER_MODULES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function loadAdapterModules(
  registry: AdapterRegistry,
  specifiers: readonly string[],
  metrics?: ServerMetrics,
): Promise<void> {
  const seen = new Set<string>();
  for (const specifier of specifiers) {
    if (seen.has(specifier)) throw new Error(`adapter module ${specifier} is duplicated`);
    seen.add(specifier);
    const imported = (await import(specifier)) as {
      createSession?: unknown;
      manifest?: unknown;
    };
    if (typeof imported.createSession !== 'function') {
      throw new Error(`adapter module ${specifier} does not export createSession`);
    }
    const manifest = adapterManifestSchema.parse(imported.manifest);
    if (manifest.moduleEntry !== specifier) {
      throw new Error(`adapter ${manifest.id} moduleEntry must equal its load specifier`);
    }
    registry.register(manifest);
    log.info('loaded adapter', manifest.id);
    metrics?.adaptersLoaded.inc(1, { adapter: manifest.id });
  }
}

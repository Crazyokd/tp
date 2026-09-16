import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { RecordArtifactInput } from '@tp/contract/adapter';
import { resolveRunArtifactPath, type Artifact, type RunArtifactEvent } from '@tp/contract';

const SIDECAR_NAME = '.tp-artifacts.json';

type SidecarItem = Artifact & { path: string };

type Sidecar = {
  items: SidecarItem[];
};

type RunArtifactStoreOptions = {
  resourceRoot: string;
  nextRevision: () => number;
  onRecord: (event: RunArtifactEvent) => void;
};

export function createRunArtifactStore(options: RunArtifactStoreOptions) {
  const sidecarPath = join(options.resourceRoot, SIDECAR_NAME);
  const items = loadSidecar(sidecarPath);
  const recordedPaths = new Set(items.map((item) => item.path));

  function recordArtifact(input: RecordArtifactInput): { id: string } {
    const path = resolveRunArtifactPath(input.path);
    if (recordedPaths.has(path)) throw new Error(`artifact path already recorded: ${path}`);
    const absolute = join(options.resourceRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`artifact file does not exist: ${input.path}`);
    }
    const artifact: Artifact = {
      id: randomUUID(),
      name: input.name,
      mediaType: input.mediaType,
    };
    items.push({ ...artifact, path });
    recordedPaths.add(path);
    writeFileSync(sidecarPath, `${JSON.stringify({ items } satisfies Sidecar)}\n`);
    options.onRecord({ revision: options.nextRevision(), artifact });
    return { id: artifact.id };
  }

  async function readArtifact(artifactId: string): Promise<{ bytes: Buffer; name: string; mediaType: string }> {
    return readArtifactFrom(options.resourceRoot, items, artifactId);
  }

  async function purgeUnregistered(): Promise<void> {
    purgeDirectory(options.resourceRoot, options.resourceRoot, recordedPaths);
  }

  return { recordArtifact, readArtifact, purgeUnregistered };
}

export function openRunArtifactStore(resourceRoot: string) {
  const items = loadSidecar(join(resourceRoot, SIDECAR_NAME));
  return {
    readArtifact(artifactId: string) {
      return readArtifactFrom(resourceRoot, items, artifactId);
    },
  };
}

async function readArtifactFrom(
  resourceRoot: string,
  items: SidecarItem[],
  artifactId: string,
): Promise<{ bytes: Buffer; name: string; mediaType: string }> {
  const item = items.find((candidate) => candidate.id === artifactId);
  if (!item) throw new Error(`artifact ${artifactId} not found`);
  return {
    bytes: await readFile(join(resourceRoot, item.path)),
    name: item.name,
    mediaType: item.mediaType,
  };
}

function loadSidecar(sidecarPath: string): SidecarItem[] {
  if (!existsSync(sidecarPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Sidecar).items)) {
    throw new Error('invalid artifact sidecar');
  }
  return (parsed as Sidecar).items;
}

function purgeDirectory(root: string, directory: string, recordedPaths: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (directory === root && entry.name === SIDECAR_NAME) continue;
    if (entry.isDirectory()) {
      purgeDirectory(root, absolute, recordedPaths);
      if (readdirSync(absolute).length === 0) rmdirSync(absolute);
      continue;
    }
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (!recordedPaths.has(relativePath)) unlinkSync(absolute);
  }
}

import { runArtifactPath, type Run } from '@tp/contract';

export type RunArtifactItem = {
  id: string;
  name: string;
  href: string;
  mediaType: string;
};

export function runArtifactItems(run: Pick<Run, 'id' | 'artifacts'>): RunArtifactItem[] {
  return run.artifacts.map((item) => ({
    id: item.id,
    name: item.name,
    href: runArtifactPath(run.id, item.id),
    mediaType: item.mediaType,
  }));
}

export function artifactKind(mediaType: string): 'video' | 'image' | 'text' | 'file' {
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('text/')) return 'text';
  return 'file';
}

export const APP_VIEWS = ['runs', 'cases', 'groups', 'builder', 'workers'] as const;

export type AppView = (typeof APP_VIEWS)[number];

export type AppLocation = {
  view: AppView;
  batchId: string | null;
};

export function parseAppLocation(hash: string): AppLocation {
  const value = hash.startsWith('#/') ? hash.slice(2) : '';
  const [head, batch, extra] = value.split('/');
  if (head === 'runs' && extra === undefined && batch) {
    try {
      return { view: 'runs', batchId: decodeURIComponent(batch) };
    } catch {
      return { view: 'runs', batchId: null };
    }
  }
  const view = APP_VIEWS.find((item) => item === value);
  return { view: view ?? 'runs', batchId: null };
}

export function appViewHash(view: AppView): string {
  return `#/${view}`;
}

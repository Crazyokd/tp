export const APP_VIEWS = ['runs', 'cases', 'builder', 'workers'] as const;

export type AppView = (typeof APP_VIEWS)[number];

export function parseAppView(hash: string): AppView {
  const value = hash.startsWith('#/') ? hash.slice(2) : '';
  return APP_VIEWS.find((view) => view === value) ?? 'runs';
}

export function appViewHash(view: AppView): string {
  return `#/${view}`;
}

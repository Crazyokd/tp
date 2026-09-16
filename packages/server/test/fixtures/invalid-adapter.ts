export const manifest = {
  id: '',
  moduleEntry: import.meta.url,
  capabilities: [],
};

export function createSession(): never {
  throw new Error('invalid adapter');
}

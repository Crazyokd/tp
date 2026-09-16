export class BlackboardError extends Error {}

type Frame = {
  values: Map<string, unknown>;
  remap: Map<string, string>;
  parent: Frame | null;
};

export function createRunBlackboard() {
  const root: Frame = { values: new Map(), remap: new Map(), parent: null };
  const stack: Frame[] = [root];

  function current(): Frame {
    return stack[stack.length - 1] ?? root;
  }

  function lookup(key: string): unknown {
    let frame: Frame | null = current();
    while (frame) {
      const remapped = frame.remap.get(key);
      if (remapped !== undefined) {
        key = remapped;
        frame = frame.parent;
        continue;
      }
      if (frame.values.has(key)) return frame.values.get(key);
      return undefined;
    }
    return undefined;
  }

  function write(key: string, value: unknown): void {
    let frame: Frame | null = current();
    while (frame) {
      const remapped = frame.remap.get(key);
      if (remapped !== undefined) {
        key = remapped;
        frame = frame.parent;
        continue;
      }
      frame.values.set(key, value);
      return;
    }
    root.values.set(key, value);
  }

  return {
    pushAlias(remap: Record<string, { key: string }> = {}): void {
      const aliases = new Map<string, string>();
      for (const [inner, binding] of Object.entries(remap)) {
        aliases.set(inner, binding.key);
      }
      stack.push({ values: new Map(), remap: aliases, parent: current() });
    },
    pop(): void {
      if (stack.length > 1) stack.pop();
    },
    peek(key: string): unknown {
      return lookup(key);
    },
    write,
  };
}

export type RunBlackboard = ReturnType<typeof createRunBlackboard>;

export function isBlackboardRef(value: unknown): value is string {
  return typeof value === 'string' && /^\{[^{}]+\}$/.test(value);
}

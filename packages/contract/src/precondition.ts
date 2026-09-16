export class PreconditionSyntaxError extends Error {}

export type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'ref'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lp' }
  | { kind: 'rp' };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '{') {
      const end = source.indexOf('}', index);
      if (end < 0) throw new PreconditionSyntaxError(`invalid precondition: ${source}`);
      const key = source.slice(index + 1, end).trim();
      if (!key || /[{}]/.test(key)) throw new PreconditionSyntaxError(`invalid precondition: ${source}`);
      tokens.push({ kind: 'ref', value: key });
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end < 0) throw new PreconditionSyntaxError(`invalid precondition: ${source}`);
      tokens.push({ kind: 'string', value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (
      source.startsWith('&&', index) ||
      source.startsWith('||', index) ||
      source.startsWith('==', index) ||
      source.startsWith('!=', index) ||
      source.startsWith('<=', index) ||
      source.startsWith('>=', index)
    ) {
      tokens.push({ kind: 'op', value: source.slice(index, index + 2) });
      index += 2;
      continue;
    }
    if ('!<>'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lp' });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rp' });
      index += 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(?:\.\d+)?/.exec(source.slice(index));
      if (!match) throw new PreconditionSyntaxError(`invalid precondition: ${source}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (source.startsWith('true', index) && !/\w/.test(source[index + 4] ?? '')) {
      tokens.push({ kind: 'boolean', value: true });
      index += 4;
      continue;
    }
    if (source.startsWith('false', index) && !/\w/.test(source[index + 5] ?? '')) {
      tokens.push({ kind: 'boolean', value: false });
      index += 5;
      continue;
    }
    throw new PreconditionSyntaxError(`invalid precondition: ${source}`);
  }
  return tokens;
}

export function assertPreconditionSyntax(source: string): void {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  parser.parseExpression();
  parser.expectEnd();
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseExpression(): void {
    this.parseOr();
  }

  expectEnd(): void {
    if (this.index < this.tokens.length) throw new PreconditionSyntaxError('invalid precondition');
  }

  private parseOr(): void {
    this.parseAnd();
    while (this.matchOp('||')) this.parseAnd();
  }

  private parseAnd(): void {
    this.parseNot();
    while (this.matchOp('&&')) this.parseAnd();
  }

  private parseNot(): void {
    if (this.matchOp('!')) {
      this.parseNot();
      return;
    }
    this.parseComparison();
  }

  private parseComparison(): void {
    this.parsePrimary();
    const op = this.peekOp();
    if (!op || !['==', '!=', '<', '<=', '>', '>='].includes(op)) return;
    this.index += 1;
    this.parsePrimary();
  }

  private parsePrimary(): void {
    const token = this.tokens[this.index];
    if (!token) throw new PreconditionSyntaxError('invalid precondition');
    if (token.kind === 'lp') {
      this.index += 1;
      this.parseExpression();
      const close = this.tokens[this.index];
      if (close?.kind !== 'rp') throw new PreconditionSyntaxError('invalid precondition');
      this.index += 1;
      return;
    }
    this.index += 1;
    if (token.kind === 'ref' || token.kind === 'number' || token.kind === 'string' || token.kind === 'boolean') return;
    throw new PreconditionSyntaxError('invalid precondition');
  }

  private matchOp(value: string): boolean {
    if (this.peekOp() !== value) return false;
    this.index += 1;
    return true;
  }

  private peekOp(): string | undefined {
    const token = this.tokens[this.index];
    return token?.kind === 'op' ? token.value : undefined;
  }
}

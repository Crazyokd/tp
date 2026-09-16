import { PreconditionSyntaxError, tokenize, type Token } from '@tp/contract';

export class PreconditionError extends Error {}

export function evaluatePrecondition(source: string, lookup: (key: string) => unknown): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (error instanceof PreconditionSyntaxError) throw new PreconditionError(error.message);
    throw error;
  }
  const parser = new Parser(tokens, lookup);
  const value = parser.parseExpression();
  parser.expectEnd();
  return asBoolean(value, source);
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly lookup: (key: string) => unknown;

  constructor(tokens: Token[], lookup: (key: string) => unknown) {
    this.tokens = tokens;
    this.lookup = lookup;
  }

  parseExpression(): unknown {
    return this.parseOr();
  }

  expectEnd(): void {
    if (this.index < this.tokens.length) throw new PreconditionError('invalid precondition');
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = asBoolean(left) || asBoolean(this.parseAnd());
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.matchOp('&&')) left = asBoolean(left) && asBoolean(this.parseAnd());
    return left;
  }

  private parseNot(): unknown {
    if (this.matchOp('!')) return !asBoolean(this.parseNot());
    return this.parseComparison();
  }

  private parseComparison(): unknown {
    const left = this.parsePrimary();
    const op = this.peekOp();
    if (!op || !['==', '!=', '<', '<=', '>', '>='].includes(op)) return left;
    this.index += 1;
    const right = this.parsePrimary();
    switch (op) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return asNumber(left) < asNumber(right);
      case '<=':
        return asNumber(left) <= asNumber(right);
      case '>':
        return asNumber(left) > asNumber(right);
      case '>=':
        return asNumber(left) >= asNumber(right);
      default:
        throw new PreconditionError('invalid precondition');
    }
  }

  private parsePrimary(): unknown {
    const token = this.tokens[this.index];
    if (!token) throw new PreconditionError('invalid precondition');
    if (token.kind === 'lp') {
      this.index += 1;
      const value = this.parseExpression();
      const close = this.tokens[this.index];
      if (close?.kind !== 'rp') throw new PreconditionError('invalid precondition');
      this.index += 1;
      return value;
    }
    this.index += 1;
    if (token.kind === 'ref') return this.lookup(token.value);
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'boolean') return token.value;
    throw new PreconditionError('invalid precondition');
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

function asBoolean(value: unknown, source?: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new PreconditionError(source ? `invalid precondition: ${source}` : 'precondition value is not boolean');
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new PreconditionError('precondition comparison requires numbers');
}

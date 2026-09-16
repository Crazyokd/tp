export type JsonHighlightKind = 'key' | 'string' | 'number' | 'punct' | 'other';

export type JsonHighlightSpan = {
  kind: JsonHighlightKind;
  text: string;
};

const space = new Set([' ', '\n', '\r', '\t']);
const punct = new Set(['{', '}', '[', ']', ',', ':']);

export function highlightJson(text: string): JsonHighlightSpan[] {
  try {
    JSON.parse(text);
  } catch {
    throw new Error('highlightJson: invalid JSON');
  }
  const spans: JsonHighlightSpan[] = [];
  let i = 0;

  const push = (kind: JsonHighlightKind, start: number, end: number) => {
    if (end > start) spans.push({ kind, text: text.slice(start, end) });
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;
    if (space.has(ch)) {
      const start = i;
      while (i < text.length && space.has(text[i] ?? '')) i += 1;
      push('other', start, i);
      continue;
    }
    if (punct.has(ch)) {
      push('punct', i, i + 1);
      i += 1;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      let look = i;
      while (look < text.length && space.has(text[look] ?? '')) look += 1;
      push(text[look] === ':' ? 'key' : 'string', start, i);
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error('highlightJson: invalid number');
      i += match[0].length;
      push('number', start, i);
      continue;
    }
    if (text.startsWith('true', i) || text.startsWith('null', i)) {
      push('other', i, i + 4);
      i += 4;
      continue;
    }
    if (text.startsWith('false', i)) {
      push('other', i, i + 5);
      i += 5;
      continue;
    }
    throw new Error(`highlightJson: unexpected ${JSON.stringify(ch)} at ${i}`);
  }

  if (spans.map((span) => span.text).join('') !== text) {
    throw new Error('highlightJson: spans do not cover source');
  }
  return spans;
}

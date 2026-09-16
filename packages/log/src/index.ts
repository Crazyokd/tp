import { format } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Logger = {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type CreateLoggerOptions = {
  level?: LogLevel;
  write?: (line: string) => void;
};

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

function isLogLevel(value: unknown): value is LogLevel {
  return (LEVELS as readonly unknown[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatArg(value: unknown): unknown {
  if (value instanceof Error) return value.stack ?? value.message;
  return value;
}

function resolveLevel(options: Record<string, unknown> | undefined): LogLevel {
  if (options && Object.hasOwn(options, 'level')) {
    if (!isLogLevel(options.level)) throw new Error('invalid log level');
    return options.level;
  }
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv !== undefined) {
    if (!isLogLevel(fromEnv)) throw new Error('invalid LOG_LEVEL');
    return fromEnv;
  }
  return 'info';
}

function resolveWrite(options: Record<string, unknown> | undefined): (line: string) => void {
  if (options && Object.hasOwn(options, 'write')) {
    if (typeof options.write !== 'function') throw new Error('logger write must be a function');
    return options.write as (line: string) => void;
  }
  return (line) => {
    process.stderr.write(`${line}\n`);
  };
}

export function createLogger(name: string, options?: CreateLoggerOptions): Logger {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('logger name must be a non-empty string');
  }
  if (options !== undefined && !isPlainObject(options)) {
    throw new Error('logger options must be an object');
  }
  const resolved = options;
  const minLevel = resolveLevel(resolved);
  const write = resolveWrite(resolved);
  const loggerName = name.trim();

  const emit = (level: LogLevel, args: unknown[]): void => {
    if (RANK[level] < RANK[minLevel]) return;
    const prefix = `${new Date().toISOString()} ${LABEL[level]} ${loggerName}`;
    const line = args.length === 0 ? prefix : `${prefix} ${format(...args.map(formatArg))}`;
    write(line);
  };

  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

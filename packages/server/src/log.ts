import { createLogger, type Logger } from '@tp/log';

type LogWrite = (line: string) => void;

let currentWrite: LogWrite | undefined;

export function setLogWrite(write?: LogWrite): () => void {
  const previous = currentWrite;
  currentWrite = write;
  return () => {
    currentWrite = previous;
  };
}

function writeLine(line: string): void {
  if (currentWrite) {
    currentWrite(line);
    return;
  }
  process.stderr.write(`${line}\n`);
}

export function logger(name: string): Logger {
  return createLogger(name, { write: writeLine });
}

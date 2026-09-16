import { httpStatusForCode, type ApiError } from '@tp/contract';

export class HttpError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'conflict' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorResponse(error: unknown): { status: number; body: ApiError } {
  if (error instanceof HttpError) {
    return { status: httpStatusForCode(error.code), body: { code: error.code, message: error.message } };
  }
  const message = (error instanceof Error ? error.message : String(error)).trim() || 'invalid request';
  return { status: httpStatusForCode('invalid'), body: { code: 'invalid', message } };
}

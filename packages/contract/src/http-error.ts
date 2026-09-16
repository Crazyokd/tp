import { z } from 'zod';

const apiErrorCodeSchema = z.enum(['not_found', 'invalid', 'conflict', 'forbidden']);

export const apiErrorSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export function httpStatusForCode(code: ApiErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'invalid':
      return 400;
    case 'conflict':
      return 409;
    case 'forbidden':
      return 403;
  }
}

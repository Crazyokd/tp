import { z } from 'zod';

export const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasLimit = value.limit !== undefined;
    const hasOffset = value.offset !== undefined;
    if (hasLimit !== hasOffset) {
      ctx.addIssue({
        code: 'custom',
        message: 'limit and offset must both be provided or both omitted',
      });
    }
  });

export type PageQuery = z.infer<typeof pageQuerySchema>;

export function paginate<T>(items: readonly T[], query: PageQuery): { items: T[]; total: number } {
  const total = items.length;
  if (query.limit === undefined || query.offset === undefined) {
    return { items: [...items], total };
  }
  return { items: items.slice(query.offset, query.offset + query.limit), total };
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item),
      total: z.number().int().min(0),
    })
    .strict();
}

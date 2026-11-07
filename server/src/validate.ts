import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw badRequest(`${i.path.join('.') || 'datos'}: ${i.message}`);
  }
  return r.data;
}

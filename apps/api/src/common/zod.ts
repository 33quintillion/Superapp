import { z } from 'zod';
import { Errors } from './errors';

/** Parse untrusted input, raising a 400 with field-level issues on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw Errors.validation(res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return res.data;
}

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());

export const usernameSchema = z
  .string()
  .trim()
  .transform((u) => u.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{3,30}$/, 'Use 3-30 letters, numbers or underscores'));

/** Length bounds only; strength is checked against a breached/common list later (see docs/risks.md). */
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(256);

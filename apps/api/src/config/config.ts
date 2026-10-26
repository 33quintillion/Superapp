import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. Secrets never have defaults outside of NODE_ENV=test.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.stringbool().default(false),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('nexa-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** 32-byte key, base64. Encrypts server-held secrets at rest (e.g. TOTP seeds). */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  /** "smtp" for real delivery (Mailpit locally, a provider in staging/prod); "memory" only in tests. */
  MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Nexa <no-reply@localhost>'),
  PUBLIC_WEB_URL: z.url().default('http://localhost:3001'),

  RATE_LIMIT_DISABLED: z.stringbool().default(false),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.MAIL_TRANSPORT === 'memory' && cfg.NODE_ENV !== 'test') {
    throw new Error('MAIL_TRANSPORT=memory is only allowed when NODE_ENV=test');
  }
  if (cfg.MAIL_TRANSPORT === 'smtp' && !cfg.SMTP_URL) {
    throw new Error('SMTP_URL is required when MAIL_TRANSPORT=smtp');
  }
  if (cfg.RATE_LIMIT_DISABLED && (cfg.NODE_ENV === 'production' || cfg.NODE_ENV === 'staging')) {
    throw new Error('RATE_LIMIT_DISABLED cannot be set in staging or production');
  }
  return cfg;
}

import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. Secrets never have defaults outside of NODE_ENV=test.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Which peers may set X-Forwarded-For (docs/hardening.md#client-addresses): false for none,
   * or a comma-separated list of proxy IPs and CIDRs (also loopback, linklocal, uniquelocal).
   * true trusts any peer, so anyone could pick their own address; it is refused when deployed.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, ctx): boolean | string[] => {
      const t = v.trim().toLowerCase();
      if (t === 'true' || t === 'false') return t === 'true';
      const list = t.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length && list.every((a) => /^((\d{1,3}(\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]*)(\/\d{1,3})?|loopback|linklocal|uniquelocal)$/.test(a))) return list;
      ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY must be true, false, or a comma-separated list of proxy IPs or CIDRs' });
      return z.NEVER;
    }),
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

  /** S3-compatible object storage for media (MinIO locally, any S3 provider in staging/prod). */
  S3_ENDPOINT: z.url().optional(),
  /** Endpoint that clients use for presigned URLs, if it differs from the one the API uses. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'S3_BUCKET must be a valid bucket name'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  /** Creates the bucket at startup. For local development and tests only. */
  S3_AUTO_CREATE_BUCKET: z.stringbool().default(false),

  /** How often an open WebSocket re-checks that its session is still valid. */
  WS_SESSION_RECHECK_SECONDS: z.coerce.number().int().positive().default(30),
  WS_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(25),

  /** How often expired stories (and their files) are deleted. 0 turns the sweep off on this instance. */
  STORY_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),

  /** Runs the push delivery loop in this process. Turn off on instances that should only serve requests. */
  PUSH_WORKER_ENABLED: z.stringbool().default(true),
  PUSH_WORKER_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  /** A notification not delivered within this long is dropped; it would only be noise by then. */
  PUSH_TTL_SECONDS: z.coerce.number().int().positive().max(28 * 24 * 3600).default(24 * 3600),

  /** Apple Push Notification service, token-based auth (.p8 key). All four or none. */
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  /** Contents of the .p8 file (PEM). "\n" escapes are accepted for single-line env files. */
  APNS_PRIVATE_KEY: z.string().optional(),
  /** Overrides the Apple host for every device. Tests only; refused in staging and production. */
  APNS_ENDPOINT: z.url().optional(),

  /** Firebase Cloud Messaging HTTP v1: the service account JSON, raw or base64. */
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Overrides https://fcm.googleapis.com. Tests only; refused in staging and production. */
  FCM_ENDPOINT: z.url().optional(),

  /** Web Push (VAPID, RFC 8292). Generate with `pnpm --filter @nexa/api vapid-keys`. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contact for push services: mailto:you@example.com or an https URL. */
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, 'VAPID_SUBJECT must start with mailto: or https://').optional(),
  /**
   * Hosts that Web Push subscriptions may point at (suffix match). The API sends requests
   * to these URLs, so only real browser push services are allowed by default.
   */
  WEBPUSH_ALLOWED_HOSTS: z
    .string()
    .default('fcm.googleapis.com,updates.push.services.mozilla.com,push.apple.com,notify.windows.com')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),

  /** Calls (docs/calls.md). How long an unanswered call rings before it counts as missed. */
  CALL_RING_SECONDS: z.coerce.number().int().min(5).max(180).default(45),
  /** An answered call whose media has not connected within this long has failed. */
  CALL_CONNECT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  /** How long a device that dropped off mid-call has to reconnect before the call ends. */
  CALL_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(1).max(120).default(20),
  /** How often this instance ends calls that timed out. 0 turns the sweep off on this instance. */
  CALL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(2000),

  /** STUN servers given to every call, comma-separated (e.g. stun:stun.cloudflare.com:3478). */
  STUN_URLS: z.string().default('').transform(list),
  /**
   * Where TURN relay credentials come from. none: STUN only (calls fail behind strict NATs).
   * coturn: your own coturn with use-auth-secret. twilio / cloudflare: their managed TURN.
   */
  TURN_PROVIDER: z.enum(['none', 'coturn', 'twilio', 'cloudflare']).default('none'),
  /** relay forces every call through TURN, hiding each person's IP address from the other. */
  ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),
  /** Lifetime of issued TURN credentials. Longer than your longest expected call. */
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(4 * 3600),
  /** coturn: turn:/turns: URLs, comma-separated, and the static-auth-secret from turnserver.conf. */
  TURN_URLS: z.string().default('').transform(list),
  TURN_SHARED_SECRET: z.string().optional(),
  /** Twilio Network Traversal Service: account SID plus an API key (SK...) and its secret. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  /** Overrides https://api.twilio.com. Tests only; refused in staging and production. */
  TWILIO_API_BASE: z.url().optional(),
  /** Cloudflare Realtime TURN: the TURN key id and its API token. */
  CLOUDFLARE_TURN_KEY_ID: z.string().optional(),
  CLOUDFLARE_TURN_API_TOKEN: z.string().optional(),
  /** Overrides https://rtc.live.cloudflare.com. Tests only; refused in staging and production. */
  CLOUDFLARE_TURN_API_BASE: z.url().optional(),

  // Admin dashboard: platform staff must have signed in with a two-step code within this many hours.
  ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(72).default(12),

  /** Payments (docs/payments.md). none: everything is paid in person and plans can't be bought. */
  PAYMENTS_PROVIDER: z.enum(['none', 'stripe']).default('none'),
  /** Secret (sk_) or restricted (rk_) key. Test keys everywhere except production, live keys only there. */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Webhook signing secrets (whsec_...), comma-separated so a secret can be rotated without downtime. */
  STRIPE_WEBHOOK_SECRET: z.string().default('').transform(list),
  /** Overrides https://api.stripe.com. Tests and the local sandbox only; refused in staging and production. */
  STRIPE_API_BASE: z.url().optional(),
  /** How old a webhook's signature timestamp may be, in seconds. */
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  /** The platform's fee on online orders, in basis points (100 = 1%). */
  PAYMENTS_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(3000).default(0),
  /** How long a customer has to pay before an online order is cancelled and its stock released. */
  PAYMENTS_CHECKOUT_MINUTES: z.coerce.number().int().min(30).max(1440).default(30),
  /** How often this instance tidies up unpaid orders and retries unsent refunds. 0 turns it off. */
  PAYMENTS_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
});

function list(v: string) {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  if (cfg.S3_AUTO_CREATE_BUCKET && (cfg.NODE_ENV === 'production' || cfg.NODE_ENV === 'staging')) {
    throw new Error('S3_AUTO_CREATE_BUCKET cannot be set in staging or production; provision the bucket instead');
  }
  const deployed = cfg.NODE_ENV === 'production' || cfg.NODE_ENV === 'staging';
  if (deployed && cfg.TRUST_PROXY === true) {
    throw new Error('TRUST_PROXY=true lets any client forge its address; in staging and production list the proxy addresses instead');
  }
  const apns = [cfg.APNS_KEY_ID, cfg.APNS_TEAM_ID, cfg.APNS_BUNDLE_ID, cfg.APNS_PRIVATE_KEY].filter(Boolean).length;
  if (apns !== 0 && apns !== 4) {
    throw new Error('APNs needs all of APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID and APNS_PRIVATE_KEY, or none of them');
  }
  const vapid = [cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY, cfg.VAPID_SUBJECT].filter(Boolean).length;
  if (vapid !== 0 && vapid !== 3) {
    throw new Error('Web Push needs all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, or none of them');
  }
  const turnNeeds: Record<typeof cfg.TURN_PROVIDER, [string, unknown][]> = {
    none: [],
    coturn: [
      ['TURN_URLS', cfg.TURN_URLS.length ? cfg.TURN_URLS : undefined],
      ['TURN_SHARED_SECRET', cfg.TURN_SHARED_SECRET],
    ],
    twilio: [
      ['TWILIO_ACCOUNT_SID', cfg.TWILIO_ACCOUNT_SID],
      ['TWILIO_API_KEY_SID', cfg.TWILIO_API_KEY_SID],
      ['TWILIO_API_KEY_SECRET', cfg.TWILIO_API_KEY_SECRET],
    ],
    cloudflare: [
      ['CLOUDFLARE_TURN_KEY_ID', cfg.CLOUDFLARE_TURN_KEY_ID],
      ['CLOUDFLARE_TURN_API_TOKEN', cfg.CLOUDFLARE_TURN_API_TOKEN],
    ],
  };
  const missing = turnNeeds[cfg.TURN_PROVIDER].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`TURN_PROVIDER=${cfg.TURN_PROVIDER} needs ${missing.join(', ')}`);
  for (const u of [...cfg.STUN_URLS, ...cfg.TURN_URLS]) {
    if (!/^(stuns?|turns?):[^\s]+$/.test(u)) throw new Error(`Not a STUN/TURN URL: ${u}`);
  }
  if (cfg.TURN_PROVIDER === 'coturn' && cfg.TURN_URLS.some((u) => !u.startsWith('turn'))) {
    throw new Error('TURN_URLS must be turn: or turns: URLs');
  }
  if (cfg.ICE_TRANSPORT_POLICY === 'relay' && cfg.TURN_PROVIDER === 'none') {
    throw new Error('ICE_TRANSPORT_POLICY=relay needs a TURN_PROVIDER, or no call could ever connect');
  }
  for (const [name, url] of [
    ['APNS_ENDPOINT', cfg.APNS_ENDPOINT],
    ['FCM_ENDPOINT', cfg.FCM_ENDPOINT],
    ['TWILIO_API_BASE', cfg.TWILIO_API_BASE],
    ['CLOUDFLARE_TURN_API_BASE', cfg.CLOUDFLARE_TURN_API_BASE],
    ['STRIPE_API_BASE', cfg.STRIPE_API_BASE],
  ] as const) {
    if (url && deployed) throw new Error(`${name} is for tests only; it cannot be set in staging or production`);
  }
  if (deployed && cfg.TURN_PROVIDER === 'none' && !cfg.STUN_URLS.length) {
    // Without STUN or TURN, devices only offer local addresses, so calls connect only on one network.
    throw new Error('TURN_PROVIDER=none needs STUN_URLS in staging and production (e.g. stun:stun.cloudflare.com:3478)');
  }
  if (cfg.PAYMENTS_PROVIDER === 'stripe') {
    if (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_WEBHOOK_SECRET.length) throw new Error('PAYMENTS_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
    const live = /^(sk|rk)_live_/.test(cfg.STRIPE_SECRET_KEY);
    if (!live && !/^(sk|rk)_test_/.test(cfg.STRIPE_SECRET_KEY)) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_ or rk_)');
    // Sandbox and live money never mix (ADR 0005).
    if (cfg.NODE_ENV === 'production' && !live) throw new Error('Production needs a live Stripe key (sk_live_ or rk_live_)');
    if (cfg.NODE_ENV !== 'production' && live) throw new Error(`A live Stripe key can only be used in production, not ${cfg.NODE_ENV}`);
    if (cfg.STRIPE_WEBHOOK_SECRET.some((s) => !s.startsWith('whsec_'))) throw new Error('STRIPE_WEBHOOK_SECRET values start with whsec_');
  }
  return cfg;
}

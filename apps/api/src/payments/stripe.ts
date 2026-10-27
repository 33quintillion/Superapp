import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A small client for the parts of the Stripe API that Nexa uses, over plain HTTPS: form-
 * encoded requests, an Idempotency-Key on every POST, and a pinned API version so a
 * dashboard upgrade can't change response shapes under us. Hosted Checkout keeps card
 * details off our servers (PCI DSS SAQ A).
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';
const TIMEOUT_MS = 10_000;

export class ProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status from the provider, or 0 when it couldn't be reached. */
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
  /** Worth trying again later with the same idempotency key. */
  get retryable() {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export type Params = { [key: string]: string | number | boolean | null | undefined | Params | Params[] | string[] };

/** Stripe's bracket notation: { a: { b: 1 }, c: [{ d: 2 }] } → a[b]=1&c[0][d]=2. */
export function formEncode(params: Params, prefix = ''): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') out.push(formEncode(item, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, any> };
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly base = 'https://api.stripe.com',
  ) {}

  /** True for live keys (sk_live_ / rk_live_). */
  get livemode() {
    return /^(sk|rk)_live_/.test(this.secretKey);
  }

  async post<T = Record<string, any>>(path: string, params: Params, idempotencyKey: string): Promise<T> {
    return this.request<T>('POST', path, formEncode(params), idempotencyKey);
  }

  async get<T = Record<string, any>>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async delete<T = Record<string, any>>(path: string, idempotencyKey: string): Promise<T> {
    return this.request<T>('DELETE', path, undefined, idempotencyKey);
  }

  private async request<T>(method: string, path: string, body?: string, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError(`Stripe could not be reached: ${(err as Error).message}`, 0);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; type?: string } };
    if (!res.ok) throw new ProviderError(`Stripe answered ${res.status}: ${json.error?.message ?? 'no message'}`, res.status, json.error?.code ?? json.error?.type);
    return json as T;
  }
}

/**
 * Checks a Stripe-Signature header ("t=<unix>,v1=<hex>[,v1=...]") against each webhook
 * secret: HMAC-SHA256 of "<t>.<raw body>", compared in constant time, and the timestamp
 * must be within the tolerance so a captured request can't be replayed later.
 */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secrets: string[], toleranceSeconds: number, now = Date.now()): StripeEvent {
  if (!header) throw new SignatureError('missing Stripe-Signature header');
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === undefined || !sigs.length) throw new SignatureError('malformed Stripe-Signature header');
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new SignatureError('timestamp outside the tolerance');
  const signed = Buffer.concat([Buffer.from(`${t}.`), raw]);
  const ok = secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signed).digest();
    return sigs.some((s) => timingSafeEqual(expected, Buffer.from(s, 'hex')));
  });
  if (!ok) throw new SignatureError('no matching signature');
  let event: StripeEvent;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new SignatureError('body is not JSON');
  }
  if (typeof event?.id !== 'string' || typeof event.type !== 'string' || typeof event.data?.object !== 'object') throw new SignatureError('not an event');
  return event;
}

/** What Stripe's own libraries produce, for the sandbox and tests. */
export function signStripePayload(payload: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

export class SignatureError extends Error {}

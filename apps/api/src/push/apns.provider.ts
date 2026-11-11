import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { networkFailure, PushDevice, PushMessage, PushProvider, PushResult, retryAfterMs } from './push.types';

export interface ApnsOptions {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** PEM contents of the .p8 key. */
  privateKey: string;
  /** Replaces both Apple hosts (tests). */
  endpoint?: string;
  timeoutMs?: number;
}

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

/** Reasons Apple gives when a token will never work again. */
const DEAD_TOKEN = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'ExpiredToken']);
/** Our signing token was refused; mint a fresh one and retry. */
const BAD_PROVIDER_TOKEN = new Set(['ExpiredProviderToken', 'InvalidProviderToken', 'MissingProviderToken']);

/**
 * Apple Push Notification service over HTTP/2 with token-based (JWT, ES256) auth.
 * Keeps one HTTP/2 connection per Apple environment, as Apple asks, and reuses the
 * signing token for 50 minutes (Apple rejects tokens older than an hour and throttles
 * ones refreshed more often than every 20 minutes).
 */
export class ApnsProvider implements PushProvider {
  readonly name = 'apns' as const;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private jwt: { value: string; at: number } | null = null;
  private key: ReturnType<typeof importPKCS8> | null = null;

  constructor(private readonly opts: ApnsOptions) {}

  async send(device: PushDevice, message: PushMessage): Promise<PushResult> {
    const origin = this.opts.endpoint ?? HOSTS[device.apnsEnvironment ?? 'production'];
    // A clear is a background push: the app wakes briefly to remove delivered notifications.
    const background = { aps: { 'content-available': 1, badge: message.badge }, ...message.data };
    const payload = JSON.stringify(message.clear ? background : {
      aps: {
        alert: { title: message.title, body: message.body },
        badge: message.badge,
        'thread-id': message.threadId,
        // Lets the app's notification service extension mark the message delivered.
        'mutable-content': 1,
        ...(message.silent ? { 'interruption-level': 'passive' } : { sound: 'default' }),
      },
      ...message.data,
    });
    let res: { status: number; body: string; headers: http2.IncomingHttpHeaders };
    try {
      res = await this.request(origin, device.token, payload, message.ttlSeconds, !!message.clear);
    } catch (err) {
      return networkFailure(err);
    }
    if (res.status === 200) return { ok: true };
    let reason = `http ${res.status}`;
    try {
      reason = (JSON.parse(res.body) as { reason?: string }).reason ?? reason;
    } catch {
      // Non-JSON body; keep the status.
    }
    if (res.status === 410 || DEAD_TOKEN.has(reason)) return { ok: false, invalidToken: true, reason };
    if (BAD_PROVIDER_TOKEN.has(reason)) {
      this.jwt = null;
      return { ok: false, retryable: true, reason };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, reason, retryAfterMs: retryAfterMs(res.headers['retry-after']) };
    }
    return { ok: false, reason };
  }

  async close() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private async providerToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.at < 50 * 60) return this.jwt.value;
    this.key ??= importPKCS8(this.opts.privateKey.replace(/\\n/g, '\n'), 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.opts.keyId })
      .setIssuer(this.opts.teamId)
      .setIssuedAt(now)
      .sign(await this.key);
    this.jwt = { value, at: now };
    return value;
  }

  private session(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    const drop = () => {
      if (this.sessions.get(origin) === s) this.sessions.delete(origin);
    };
    s.on('error', drop);
    s.on('goaway', drop);
    s.on('close', drop);
    // Don't keep the process alive just for an idle connection.
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  private async request(origin: string, token: string, payload: string, ttlSeconds: number, background: boolean) {
    const auth = await this.providerToken();
    const session = this.session(origin);
    return new Promise<{ status: number; body: string; headers: http2.IncomingHttpHeaders }>((resolve, reject) => {
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(token)}`,
        authorization: `bearer ${auth}`,
        'apns-topic': this.opts.bundleId,
        // Apple requires priority 5 for background pushes.
        'apns-push-type': background ? 'background' : 'alert',
        'apns-priority': background ? '5' : '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds),
        'content-type': 'application/json',
      });
      req.setTimeout(this.opts.timeoutMs ?? 10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let headers: http2.IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      req.on('response', (h) => (headers = h));
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve({ status: Number(headers[':status'] ?? 0), body: Buffer.concat(chunks).toString('utf8'), headers }));
      req.on('error', reject);
      req.on('close', () => {
        if (!headers[':status']) reject(new Error('stream closed without a response'));
      });
      req.end(payload);
    });
  }
}

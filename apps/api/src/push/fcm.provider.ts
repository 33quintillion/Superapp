import { importPKCS8, SignJWT } from 'jose';
import { networkFailure, PushDevice, PushMessage, PushProvider, PushResult, retryAfterMs } from './push.types';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Accepts the service account file's JSON as-is or base64-encoded. */
export function parseServiceAccount(raw: string): FcmServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let json: Partial<FcmServiceAccount>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON (or base64 of it)');
  }
  for (const k of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof json[k] !== 'string' || !json[k]) throw new Error(`FCM_SERVICE_ACCOUNT_JSON is missing ${k}`);
  }
  return { ...(json as FcmServiceAccount), token_uri: json.token_uri ?? 'https://oauth2.googleapis.com/token' };
}

/** FCM error codes that mean the registration token will never work again. */
const DEAD_TOKEN = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

/**
 * Firebase Cloud Messaging HTTP v1, used for Android. Authenticates with a service
 * account: a signed JWT is exchanged for a one-hour OAuth access token, cached until
 * shortly before it expires.
 */
export class FcmProvider implements PushProvider {
  readonly name = 'fcm' as const;
  private access: { token: string; expiresAt: number } | null = null;
  private key: ReturnType<typeof importPKCS8> | null = null;

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly endpoint = 'https://fcm.googleapis.com',
  ) {}

  async send(device: PushDevice, message: PushMessage): Promise<PushResult> {
    // A clear is data only: the app removes the chat's notifications itself, showing nothing.
    const clear = { message: { token: device.token, data: message.data, android: { priority: 'NORMAL', ttl: `${message.ttlSeconds}s` } } };
    const body = message.clear ? clear : {
      message: {
        token: device.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: 'HIGH',
          ttl: `${message.ttlSeconds}s`,
          notification: {
            tag: message.threadId,
            notification_count: message.badge,
            // The app creates both channels; "messages_quiet" has no sound or vibration.
            channel_id: message.silent ? 'messages_quiet' : 'messages',
            ...(message.silent ? { notification_priority: 'PRIORITY_LOW' } : { default_sound: true }),
          },
        },
      },
    };
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return networkFailure(err);
    }
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    let status = `http ${res.status}`;
    let code: string | undefined;
    try {
      const err = (JSON.parse(text) as { error?: { status?: string; details?: { '@type'?: string; errorCode?: string }[] } }).error;
      status = err?.status ?? status;
      code = err?.details?.find((d) => d['@type']?.endsWith('FcmError'))?.errorCode;
    } catch {
      // Non-JSON body; keep the status.
    }
    const reason = code ?? status;
    if ((code && DEAD_TOKEN.has(code)) || res.status === 404) return { ok: false, invalidToken: true, reason };
    if (res.status === 401) {
      this.access = null;
      return { ok: false, retryable: true, reason };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, reason, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    }
    return { ok: false, reason };
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    this.key ??= importPKCS8(this.account.private_key.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.account.client_email)
      .setAudience(this.account.token_uri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await this.key);
    const res = await fetch(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FCM OAuth token request failed with ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('FCM OAuth response had no access_token');
    this.access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }
}

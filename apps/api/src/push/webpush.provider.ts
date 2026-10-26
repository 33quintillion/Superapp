import { networkFailure, PushDevice, PushMessage, PushProvider, PushResult, retryAfterMs } from './push.types';
import { encryptPayload, VapidSigner } from './webpush';

/** Browsers cap Web Push payloads at about 4 KB after encryption. */
const MAX_PLAINTEXT = 3000;

/** Browser notifications (Chrome, Firefox, Edge, Safari 16+) via the standard Web Push protocol. */
export class WebPushProvider implements PushProvider {
  readonly name = 'webpush' as const;

  constructor(private readonly vapid: VapidSigner) {}

  async send(device: PushDevice, message: PushMessage): Promise<PushResult> {
    if (!device.webpushP256dh || !device.webpushAuth) return { ok: false, invalidToken: true, reason: 'missing subscription keys' };
    const payload = Buffer.from(
      JSON.stringify({
        title: message.title,
        body: message.body.slice(0, 1000),
        tag: message.threadId,
        silent: message.silent,
        badge: message.badge,
        data: message.data,
      }),
    );
    if (payload.length > MAX_PLAINTEXT) return { ok: false, reason: 'payload too large' };
    let res: Response;
    try {
      res = await fetch(device.token, {
        method: 'POST',
        headers: {
          authorization: await this.vapid.authorization(device.token),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(message.ttlSeconds),
          urgency: message.silent ? 'normal' : 'high',
          // Replaces an undelivered notification for the same chat instead of queueing both.
          topic: message.threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
        },
        body: encryptPayload(payload, device.webpushP256dh, device.webpushAuth),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return networkFailure(err);
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const reason = `http ${res.status}`;
    // 404/410: subscription expired or unsubscribed. 403: it was made with a different
    // VAPID key (for example after a key rotation), so it can never work for us.
    if (res.status === 404 || res.status === 410 || res.status === 403) return { ok: false, invalidToken: true, reason };
    if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, reason, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    return { ok: false, reason };
  }
}

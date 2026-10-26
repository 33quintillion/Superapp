import { ApnsProvider } from '../src/push/apns.provider';
import { FcmProvider, parseServiceAccount } from '../src/push/fcm.provider';
import { inQuietHours } from '../src/push/push.service';
import { PushDevice, PushMessage, retryAfterMs } from '../src/push/push.types';
import { backoff } from '../src/push/push.worker';
import { checkVapidKeys, encryptPayload, generateVapidKeys, VapidSigner } from '../src/push/webpush';
import { WebPushProvider } from '../src/push/webpush.provider';
import { loadConfig } from '../src/config/config';
import { TEST_ENV } from './helpers';
import {
  apnsKey,
  browserSubscription,
  decryptWebPush,
  fcmError,
  fcmServiceAccount,
  startFakeApns,
  startFakeFcm,
  startWebPushService,
  verifyVapid,
} from './push-fakes';

const message: PushMessage = {
  title: 'Ana',
  body: 'hello there',
  threadId: '6f1c1d9e-7a43-4bb8-9a0e-3b8d2f6b1c11',
  silent: false,
  badge: 3,
  data: { type: 'message', conversationId: 'c1', messageId: 'm1', seq: '7' },
  ttlSeconds: 3600,
};

describe('Web Push encryption (RFC 8291)', () => {
  // RFC 8291 Appendix A.
  const v = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    expected:
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('matches the RFC test vector', () => {
    const out = encryptPayload(Buffer.from(v.plaintext), v.uaPublic, v.auth, {
      salt: Buffer.from(v.salt, 'base64url'),
      senderPrivateKey: Buffer.from(v.asPrivate, 'base64url'),
    });
    expect(out.toString('base64url')).toBe(v.expected);
  });

  it('produces payloads only the subscribing browser can read', () => {
    const sub = browserSubscription();
    const other = browserSubscription();
    const sealed = encryptPayload(Buffer.from('secret'), sub.p256dh, sub.auth);
    expect(decryptWebPush(sealed, sub).toString()).toBe('secret');
    expect(() => decryptWebPush(sealed, { ...other, authSecret: sub.authSecret })).toThrow();
    // Fresh salt and sender key every time.
    expect(encryptPayload(Buffer.from('secret'), sub.p256dh, sub.auth).equals(sealed)).toBe(false);
  });

  it('rejects malformed subscription keys', () => {
    const sub = browserSubscription();
    expect(() => encryptPayload(Buffer.from('x'), 'AAAA', sub.auth)).toThrow(/p256dh/);
    expect(() => encryptPayload(Buffer.from('x'), sub.p256dh, 'AAAA')).toThrow(/auth/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service origin that verifies with the public key', async () => {
    const keys = generateVapidKeys();
    const signer = new VapidSigner(keys, 'mailto:ops@example.test');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    const claims = await verifyVapid(await signer.authorization(endpoint), keys.publicKey, endpoint);
    expect(claims.sub).toBe('mailto:ops@example.test');
    expect(claims.exp! - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
  });

  it('refuses keys that do not belong together', () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(() => checkVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey })).toThrow(/does not match/);
    expect(() => checkVapidKeys({ publicKey: 'short', privateKey: a.privateKey })).toThrow();
  });
});

describe('quiet hours and retry timing', () => {
  const at = (iso: string) => new Date(iso);

  it('handles ranges inside one day and across midnight, in the user time zone', () => {
    // 22:00-07:00 wraps; 13:00-14:00 doesn't.
    expect(inQuietHours(22 * 60, 7 * 60, 'UTC', at('2026-01-01T23:30:00Z'))).toBe(true);
    expect(inQuietHours(22 * 60, 7 * 60, 'UTC', at('2026-01-01T06:59:00Z'))).toBe(true);
    expect(inQuietHours(22 * 60, 7 * 60, 'UTC', at('2026-01-01T07:00:00Z'))).toBe(false);
    expect(inQuietHours(13 * 60, 14 * 60, 'UTC', at('2026-01-01T13:15:00Z'))).toBe(true);
    expect(inQuietHours(13 * 60, 14 * 60, 'UTC', at('2026-01-01T14:15:00Z'))).toBe(false);
    // 23:30 UTC is 18:30 in New York (EST): not quiet there.
    expect(inQuietHours(22 * 60, 7 * 60, 'America/New_York', at('2026-01-01T23:30:00Z'))).toBe(false);
    expect(inQuietHours(null, null, 'UTC')).toBe(false);
  });

  it('backs off exponentially with jitter, up to a cap', () => {
    for (let i = 0; i < 20; i++) {
      expect(backoff(1)).toBeGreaterThanOrEqual(8_000);
      expect(backoff(1)).toBeLessThanOrEqual(12_000);
      expect(backoff(3)).toBeGreaterThanOrEqual(32_000);
      expect(backoff(30)).toBeLessThanOrEqual(30 * 60_000 * 1.2);
    }
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
  });
});

describe('push config', () => {
  const base = { ...TEST_ENV } as Record<string, string>;
  it('needs every APNs and VAPID setting or none', () => {
    expect(() => loadConfig({ ...base, APNS_KEY_ID: 'ABC123DEFG' })).toThrow(/APNs needs all/);
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'x' })).toThrow(/Web Push needs all/);
    expect(() => loadConfig({ ...base, VAPID_SUBJECT: 'ops@example.test' })).toThrow(/mailto/);
  });
  it('refuses test endpoint overrides in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://x', S3_AUTO_CREATE_BUCKET: 'false', APNS_ENDPOINT: 'http://127.0.0.1:1' })).toThrow(
      /APNS_ENDPOINT/,
    );
  });
  it('reads a service account as JSON or base64', () => {
    const { json } = fcmServiceAccount('https://oauth2.googleapis.com/token');
    expect(parseServiceAccount(json).project_id).toBe('nexa-test');
    expect(parseServiceAccount(Buffer.from(json).toString('base64')).client_email).toMatch(/@/);
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/client_email/);
  });
});

describe('APNs provider (HTTP/2, against a local server that checks the JWT)', () => {
  const key = apnsKey();
  const opts = { keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'app.nexa.ios' };
  let apns: Awaited<ReturnType<typeof startFakeApns>>;
  let provider: ApnsProvider;
  const device: PushDevice = { id: 'd', provider: 'apns', token: 'ab'.repeat(32), webpushP256dh: null, webpushAuth: null, apnsEnvironment: 'sandbox' };

  beforeAll(async () => {
    apns = await startFakeApns({ publicKey: key.publicKey, teamId: opts.teamId, keyId: opts.keyId });
    provider = new ApnsProvider({ ...opts, privateKey: key.pem, endpoint: apns.url });
  });
  afterAll(async () => {
    await provider.close();
    await apns.close();
  });

  it('sends an alert with the right headers and payload', async () => {
    expect(await provider.send(device, message)).toEqual({ ok: true });
    const r = apns.requests.at(-1)!;
    expect(r.path).toBe(`/3/device/${device.token}`);
    expect(r.headers['apns-topic']).toBe('app.nexa.ios');
    expect(r.headers['apns-push-type']).toBe('alert');
    const body = JSON.parse(r.body.toString());
    expect(body.aps).toMatchObject({ alert: { title: 'Ana', body: 'hello there' }, badge: 3, 'thread-id': message.threadId, sound: 'default' });
    expect(body.conversationId).toBe('c1');
  });

  it('sends quietly during quiet hours', async () => {
    await provider.send(device, { ...message, silent: true });
    const aps = JSON.parse(apns.requests.at(-1)!.body.toString()).aps;
    expect(aps.sound).toBeUndefined();
    expect(aps['interruption-level']).toBe('passive');
  });

  it('maps Apple errors to dead tokens, retries and failures', async () => {
    apns.replies.queue.push({ status: 410, body: { reason: 'Unregistered' } });
    expect(await provider.send(device, message)).toMatchObject({ ok: false, invalidToken: true, reason: 'Unregistered' });
    apns.replies.queue.push({ status: 400, body: { reason: 'BadDeviceToken' } });
    expect(await provider.send(device, message)).toMatchObject({ invalidToken: true });
    apns.replies.queue.push({ status: 429, body: { reason: 'TooManyRequests' }, headers: { 'retry-after': '30' } });
    expect(await provider.send(device, message)).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
    apns.replies.queue.push({ status: 400, body: { reason: 'PayloadTooLarge' } });
    const r = await provider.send(device, message);
    expect(r).toMatchObject({ ok: false, reason: 'PayloadTooLarge' });
    expect(r).not.toHaveProperty('retryable');
  });

  it('reuses its signing token, and mints a new one when Apple says it expired', async () => {
    await provider.send(device, message);
    await provider.send(device, message);
    const [a, b] = apns.requests.slice(-2);
    expect(a!.headers.authorization).toBe(b!.headers.authorization);
    apns.replies.queue.push({ status: 403, body: { reason: 'ExpiredProviderToken' } });
    expect(await provider.send(device, message)).toMatchObject({ retryable: true });
    // Same second is fine; what matters is that the cached token was dropped.
    expect((provider as unknown as { jwt: unknown }).jwt).toBeNull();
  });

  it('treats an unreachable server as retryable', async () => {
    const dead = new ApnsProvider({ ...opts, privateKey: key.pem, endpoint: 'http://127.0.0.1:1' });
    expect(await dead.send(device, message)).toMatchObject({ ok: false, retryable: true });
    await dead.close();
  });
});

describe('FCM provider (OAuth + HTTP v1, against a local server that checks the assertion)', () => {
  let fcm: Awaited<ReturnType<typeof startFakeFcm>>;
  let provider: FcmProvider;
  const device: PushDevice = { id: 'd', provider: 'fcm', token: 'fcm-token-'.padEnd(40, 'x'), webpushP256dh: null, webpushAuth: null, apnsEnvironment: null };

  beforeAll(async () => {
    fcm = await startFakeFcm();
    const sa = fcmServiceAccount(`${fcm.url}/token`);
    fcm.trust(sa.publicKey);
    provider = new FcmProvider(parseServiceAccount(sa.json), fcm.url);
  });
  afterAll(() => fcm.close());

  it('gets an access token once and sends an Android notification', async () => {
    expect(await provider.send(device, message)).toEqual({ ok: true });
    expect(await provider.send(device, message)).toEqual({ ok: true });
    expect(fcm.tokensIssued).toHaveLength(1);
    const r = fcm.requests.at(-1)!;
    expect(r.path).toBe('/v1/projects/nexa-test/messages:send');
    const m = JSON.parse(r.body.toString()).message;
    expect(m.token).toBe(device.token);
    expect(m.notification).toEqual({ title: 'Ana', body: 'hello there' });
    expect(m.data).toEqual(message.data);
    expect(m.android).toMatchObject({ priority: 'HIGH', ttl: '3600s', notification: { tag: message.threadId, channel_id: 'messages' } });
  });

  it('maps FCM errors', async () => {
    fcm.replies.queue.push(fcmError(404, 'NOT_FOUND', 'UNREGISTERED'));
    expect(await provider.send(device, message)).toMatchObject({ invalidToken: true, reason: 'UNREGISTERED' });
    fcm.replies.queue.push({ ...fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'), headers: { 'retry-after': '5' } });
    expect(await provider.send(device, message)).toMatchObject({ retryable: true, retryAfterMs: 5000 });
    fcm.replies.queue.push(fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'));
    expect(await provider.send(device, message)).toMatchObject({ ok: false, reason: 'INVALID_ARGUMENT' });
  });

  it('gets a new access token after a 401', async () => {
    const before = fcm.tokensIssued.length;
    fcm.replies.queue.push(fcmError(401, 'UNAUTHENTICATED'));
    expect(await provider.send(device, message)).toMatchObject({ retryable: true });
    expect(await provider.send(device, message)).toEqual({ ok: true });
    expect(fcm.tokensIssued.length).toBe(before + 1);
  });
});

describe('Web Push provider', () => {
  it('posts an encrypted payload with VAPID and maps expired subscriptions', async () => {
    const svc = await startWebPushService();
    const keys = generateVapidKeys();
    const provider = new WebPushProvider(new VapidSigner(keys, 'mailto:ops@example.test'));
    const sub = browserSubscription();
    const device: PushDevice = { id: 'd', provider: 'webpush', token: svc.endpoint(), webpushP256dh: sub.p256dh, webpushAuth: sub.auth, apnsEnvironment: null };
    try {
      expect(await provider.send(device, message)).toEqual({ ok: true });
      const r = svc.requests[0]!;
      await verifyVapid(r.headers.authorization as string, keys.publicKey, device.token);
      expect(r.headers['content-encoding']).toBe('aes128gcm');
      expect(r.headers.ttl).toBe('3600');
      expect(r.headers.topic).toBe(message.threadId.replace(/-/g, ''));
      expect(JSON.parse(decryptWebPush(r.body, sub).toString())).toMatchObject({ title: 'Ana', body: 'hello there', tag: message.threadId, data: message.data });

      svc.replies.queue.push({ status: 410 });
      expect(await provider.send(device, message)).toMatchObject({ invalidToken: true });
      svc.replies.queue.push({ status: 429, headers: { 'retry-after': '7' } });
      expect(await provider.send(device, message)).toMatchObject({ retryable: true, retryAfterMs: 7000 });
      svc.replies.queue.push({ status: 413 });
      expect(await provider.send(device, message)).toMatchObject({ ok: false, reason: 'http 413' });
    } finally {
      await svc.close();
    }
  });
});

import { Pool } from 'pg';
import { PushWorker } from '../src/push/push.worker';
import { generateVapidKeys } from '../src/push/webpush';
import { clientId, nextIp, registerUser, req, startApp, TEST_ENV, TestContext, TestUser } from './helpers';
import {
  apnsKey,
  BrowserSubscription,
  browserSubscription,
  decryptWebPush,
  fcmServiceAccount,
  startFakeApns,
  startFakeFcm,
  startWebPushService,
  verifyVapid,
} from './push-fakes';

// Real API, Postgres and Redis. The push services are local servers speaking the real
// protocols (see push-fakes.ts), so everything from "message saved" to "payload a browser
// can decrypt" runs for real.
let ctx: TestContext;
let pool: Pool;
let webpush: Awaited<ReturnType<typeof startWebPushService>>;
let apns: Awaited<ReturnType<typeof startFakeApns>>;
let fcm: Awaited<ReturnType<typeof startFakeFcm>>;
let worker: PushWorker;
const vapid = generateVapidKeys();
const apnsSigning = apnsKey();

function pushEnv(): Record<string, string> {
  const sa = fcmServiceAccount(`${fcm.url}/token`);
  fcm.trust(sa.publicKey);
  return {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:ops@example.test',
    WEBPUSH_ALLOWED_HOSTS: '127.0.0.1',
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_BUNDLE_ID: 'app.nexa.ios',
    APNS_PRIVATE_KEY: apnsSigning.pem,
    APNS_ENDPOINT: apns.url,
    FCM_SERVICE_ACCOUNT_JSON: sa.json,
    FCM_ENDPOINT: fcm.url,
  };
}

beforeAll(async () => {
  webpush = await startWebPushService();
  apns = await startFakeApns({ publicKey: apnsSigning.publicKey, teamId: 'TEAM123456', keyId: 'KEY1234567' });
  fcm = await startFakeFcm();
  ctx = await startApp(pushEnv());
  worker = ctx.app.get(PushWorker);
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
});
afterAll(async () => {
  await ctx.close();
  await pool.end();
  await Promise.all([webpush.close(), apns.close(), fcm.close()]);
});

const user = () => registerUser(ctx.app, 'push');
const call = (method: string, url: string, u: { token: string }, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function direct(a: TestUser, b: TestUser): Promise<string> {
  return (await call('POST', '/v1/conversations/direct', a, { userId: b.id })).body.id;
}

async function send(u: TestUser, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await call('POST', `/v1/conversations/${conversationId}/messages`, u, { clientId: clientId(), body, ...extra });
  if (r.status !== 201) throw new Error(`send failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.message;
}

/** Subscribes the user's current session the way the web app does. */
async function subscribeBrowser(u: { token: string }) {
  const sub = browserSubscription();
  const endpoint = webpush.endpoint();
  const r = await call('PUT', '/v1/push/devices/current', u, { provider: 'webpush', endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
  expect(r.status).toBe(200);
  return { sub, endpoint, device: r.body };
}

/** Web Push deliveries the push service accepted for one endpoint, decrypted as the browser would. */
function inbox(endpoint: string, sub: BrowserSubscription) {
  const path = new URL(endpoint).pathname;
  return webpush.requests.filter((r) => r.path === path && r.status! < 300).map((r) => JSON.parse(decryptWebPush(r.body, sub).toString()));
}

async function jobsFor(messageId: string) {
  return (await pool.query('SELECT state, attempts, last_error FROM push_jobs WHERE message_id = $1', [messageId])).rows;
}

async function signIn(u: TestUser, deviceName: string) {
  const r = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: `${u.username}@example.test`, password: u.password, deviceName }, ip: nextIp() });
  expect(r.status).toBe(200);
  return { token: r.body.accessToken as string, sessionId: r.body.sessionId as string };
}

describe('registration', () => {
  it('reports which providers are configured and the VAPID key', async () => {
    const a = await user();
    const r = await call('GET', '/v1/push/config', a);
    expect(r.body).toEqual({ providers: { apns: true, fcm: true, webpush: true }, vapidPublicKey: vapid.publicKey });
  });

  it('registers one target per session, never returns tokens, and lets the user remove it', async () => {
    const a = await user();
    const { device } = await subscribeBrowser(a);
    expect(device).toMatchObject({ provider: 'webpush', current: true, deliverable: true });
    expect(JSON.stringify(device)).not.toMatch(/127\.0\.0\.1|p256dh/);
    // Re-registering from the same session replaces, not adds.
    await subscribeBrowser(a);
    expect((await call('GET', '/v1/push/devices', a)).body).toHaveLength(1);
    expect((await call('DELETE', '/v1/push/devices/current', a)).status).toBe(204);
    expect((await call('GET', '/v1/push/devices', a)).body).toHaveLength(0);
  });

  it('only accepts Web Push endpoints on known push services', async () => {
    const a = await user();
    const sub = browserSubscription();
    for (const endpoint of ['http://169.254.169.254/latest/meta-data', 'https://evil.example/push', 'http://user:pw@127.0.0.1/x', 'not a url']) {
      const r = await call('PUT', '/v1/push/devices/current', a, { provider: 'webpush', endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
      expect(r.status).toBe(400);
    }
  });

  it('validates native tokens', async () => {
    const a = await user();
    expect((await call('PUT', '/v1/push/devices/current', a, { provider: 'apns', token: 'xyz', environment: 'production' })).status).toBe(400);
    expect((await call('PUT', '/v1/push/devices/current', a, { provider: 'apns', token: 'ab'.repeat(32) })).status).toBe(400);
    expect((await call('PUT', '/v1/push/devices/current', a, { provider: 'fcm', token: 'short' })).status).toBe(400);
    const ok = await call('PUT', '/v1/push/devices/current', a, { provider: 'fcm', token: 'f'.repeat(152) });
    expect(ok.status).toBe(200);
  });

  it('moves a token to whoever signs in on that device next', async () => {
    const [a, b] = [await user(), await user()];
    const token = 'ab12'.repeat(16);
    await call('PUT', '/v1/push/devices/current', a, { provider: 'apns', token, environment: 'sandbox' });
    await call('PUT', '/v1/push/devices/current', b, { provider: 'apns', token, environment: 'sandbox' });
    expect((await call('GET', '/v1/push/devices', a)).body).toHaveLength(0);
    expect((await call('GET', '/v1/push/devices', b)).body).toHaveLength(1);
  });

  it("can't remove someone else's device", async () => {
    const [a, b] = [await user(), await user()];
    const { device } = await subscribeBrowser(a);
    expect((await call('DELETE', `/v1/push/devices/${device.id}`, b)).status).toBe(404);
    expect((await call('DELETE', `/v1/push/devices/${device.id}`, a)).status).toBe(204);
  });
});

describe('delivery', () => {
  it('delivers a new message to the other person, encrypted for their browser, and not to the sender', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    const ana = await subscribeBrowser(a);
    const m = await send(a, conv, 'Lunch at noon?');
    await worker.runOnce();
    const got = inbox(ben.endpoint, ben.sub);
    expect(got).toEqual([
      expect.objectContaining({
        title: `Test ${a.username}`,
        body: 'Lunch at noon?',
        tag: conv,
        silent: false,
        badge: 1,
        data: { type: 'message', conversationId: conv, messageId: m.id, seq: String(m.seq) },
      }),
    ]);
    expect(inbox(ana.endpoint, ana.sub)).toEqual([]);
    const r = webpush.requests.find((x) => x.path === new URL(ben.endpoint).pathname)!;
    await verifyVapid(r.headers.authorization as string, vapid.publicKey, ben.endpoint);
    expect(await jobsFor(m.id)).toEqual([{ state: 'sent', attempts: 1, last_error: null }]);
    expect((await call('GET', '/v1/push/devices', b)).body[0].lastDeliveredAt).not.toBeNull();
  });

  it('reaches every signed-in device: browser, iPhone (APNs) and Android (FCM)', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const browser = await subscribeBrowser(b);
    const iphone = await signIn(b, 'iPhone');
    const android = await signIn(b, 'Pixel');
    const apnsToken = 'cd34'.repeat(16);
    const fcmToken = `fcm_${b.id.replace(/-/g, '')}`.padEnd(64, 'z');
    await call('PUT', '/v1/push/devices/current', iphone, { provider: 'apns', token: apnsToken, environment: 'production' });
    await call('PUT', '/v1/push/devices/current', android, { provider: 'fcm', token: fcmToken });
    const m = await send(a, conv, 'Photo from the trip');
    expect(await worker.runOnce()).toMatchObject({ outcomes: { sent: 3 } });

    expect(inbox(browser.endpoint, browser.sub)).toHaveLength(1);
    const ios = apns.requests.find((r) => r.path === `/3/device/${apnsToken}`)!;
    expect(JSON.parse(ios.body.toString())).toMatchObject({ aps: { alert: { body: 'Photo from the trip' }, 'thread-id': conv }, messageId: m.id });
    const droid = fcm.requests.map((r) => JSON.parse(r.body.toString()).message).find((x) => x.token === fcmToken);
    expect(droid).toMatchObject({ notification: { body: 'Photo from the trip' }, data: { messageId: m.id } });
  });

  it('respects the preview setting', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    expect((await call('PATCH', '/v1/me/notifications', b, { preview: 'sender' })).body.preview).toBe('sender');
    await send(a, conv, 'my bank PIN is 1234');
    await worker.runOnce();
    expect((await call('PATCH', '/v1/me/notifications', b, { preview: 'none' })).body.preview).toBe('none');
    await send(a, conv, 'second secret');
    await worker.runOnce();
    const [first, second] = inbox(ben.endpoint, ben.sub);
    expect(first).toMatchObject({ title: expect.stringContaining(a.username), body: 'New message' });
    expect(second).toMatchObject({ title: 'Nexa', body: 'New message' });
    expect(JSON.stringify([first, second])).not.toMatch(/PIN|secret/);
  });

  it('labels attachments instead of sending file details', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    // Stand-in for a voice note (the upload path is covered in media.e2e).
    await send(a, conv, 'hi');
    await pool.query(`UPDATE messages SET kind = 'voice', body = '' WHERE conversation_id = $1`, [conv]);
    await worker.runOnce();
    expect(inbox(ben.endpoint, ben.sub)[0]).toMatchObject({ body: 'Voice message' });
  });

  it('sends nothing for muted chats or when push is switched off', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const conv = await direct(a, b);
    const conv2 = await direct(c, b);
    await subscribeBrowser(b);
    await call('PATCH', `/v1/conversations/${conv}`, b, { mutedUntil: new Date(Date.now() + 3600_000).toISOString() });
    const muted = await send(a, conv, 'shh');
    expect(await jobsFor(muted.id)).toEqual([]);
    await call('PATCH', '/v1/me/notifications', b, { pushEnabled: false });
    const off = await send(c, conv2, 'hello?');
    expect(await jobsFor(off.id)).toEqual([]);
  });

  it('drops a notification that is no longer useful by delivery time', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    // Read on another device before the push went out.
    const read = await send(a, conv, 'one');
    await call('POST', `/v1/conversations/${conv}/receipts`, b, { kind: 'read', seq: read.seq });
    // Deleted for everyone before the push went out.
    const deleted = await send(a, conv, 'oops');
    await call('DELETE', `/v1/messages/${deleted.id}`, a);
    // Muted after it was queued.
    const late = await send(a, conv, 'three');
    await call('PATCH', `/v1/conversations/${conv}`, b, { mutedUntil: new Date(Date.now() + 3600_000).toISOString() });
    await worker.runOnce();
    expect(inbox(ben.endpoint, ben.sub)).toEqual([]);
    expect((await jobsFor(read.id))[0]).toMatchObject({ state: 'dropped', last_error: 'already read' });
    expect((await jobsFor(deleted.id))[0]).toMatchObject({ state: 'dropped', last_error: 'message deleted' });
    expect((await jobsFor(late.id))[0]).toMatchObject({ state: 'dropped', last_error: 'conversation muted' });
  });

  it('drops queued notifications after a block or sign-out', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    const blocked = await send(a, conv, 'before block');
    await call('POST', '/v1/blocks', b, { userId: a.id });
    await worker.runOnce();
    expect((await jobsFor(blocked.id))[0]).toMatchObject({ state: 'dropped', last_error: 'blocked' });
    await call('DELETE', `/v1/blocks/${a.id}`, b);

    const queued = await send(a, conv, 'before logout');
    expect((await call('POST', '/v1/auth/logout', b)).status).toBe(204);
    await worker.runOnce();
    expect((await jobsFor(queued.id))[0]).toMatchObject({ state: 'dropped', last_error: 'signed out' });
    expect(inbox(ben.endpoint, ben.sub)).toEqual([]);
    // Nothing new is queued for the dead session, and the registration is cleaned up.
    expect(await jobsFor((await send(a, conv, 'after logout')).id)).toEqual([]);
    await worker.prune();
    expect((await pool.query('SELECT 1 FROM push_devices WHERE session_id = $1', [b.sessionId])).rowCount).toBe(0);
  });

  it('sends quietly during quiet hours', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const r = await call('PATCH', '/v1/me/notifications', b, {
      quietHours: { start: hhmm(new Date(now.getTime() - 3600_000)), end: hhmm(new Date(now.getTime() + 3600_000)), timeZone: 'UTC' },
    });
    expect(r.status).toBe(200);
    await send(a, conv, 'late night');
    await worker.runOnce();
    expect(inbox(ben.endpoint, ben.sub)[0]).toMatchObject({ silent: true, body: 'late night' });
  });

  it('validates notification settings', async () => {
    const a = await user();
    expect((await call('GET', '/v1/me/notifications', a)).body).toEqual({ pushEnabled: true, preview: 'full', quietHours: null });
    expect((await call('PATCH', '/v1/me/notifications', a, { preview: 'everything' })).status).toBe(400);
    expect((await call('PATCH', '/v1/me/notifications', a, { quietHours: { start: '22:00', end: '22:00', timeZone: 'UTC' } })).status).toBe(400);
    expect((await call('PATCH', '/v1/me/notifications', a, { quietHours: { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' } })).status).toBe(400);
    const ok = await call('PATCH', '/v1/me/notifications', a, { quietHours: { start: '22:00', end: '07:00', timeZone: 'Europe/London' } });
    expect(ok.body.quietHours).toEqual({ start: '22:00', end: '07:00', timeZone: 'Europe/London' });
    expect((await call('PATCH', '/v1/me/notifications', a, { quietHours: null })).body.quietHours).toBeNull();
  });

  it('sends a test notification to the current device', async () => {
    const a = await user();
    const me = await subscribeBrowser(a);
    expect((await call('POST', '/v1/push/devices/current/test', a)).status).toBe(202);
    await worker.runOnce();
    expect(inbox(me.endpoint, me.sub)).toEqual([expect.objectContaining({ data: { type: 'test' } })]);
    const none = await user();
    expect((await call('POST', '/v1/push/devices/current/test', none)).status).toBe(404);
  });
});

describe('reliability', () => {
  it('retries with backoff after a push service outage, then delivers once', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    webpush.replies.queue.push({ status: 503 }, { status: 429, headers: { 'retry-after': '120' } });
    const m = await send(a, conv, 'eventually');
    await worker.runOnce();
    let [job] = await jobsFor(m.id);
    expect(job).toMatchObject({ state: 'pending', attempts: 1, last_error: 'http 503' });
    // Not due yet: a second pass sends nothing.
    await worker.runOnce();
    expect((await jobsFor(m.id))[0].attempts).toBe(1);
    const due = await pool.query(`SELECT run_at > now() + interval '5 seconds' AS later FROM push_jobs WHERE message_id = $1`, [m.id]);
    expect(due.rows[0].later).toBe(true);
    await pool.query(`UPDATE push_jobs SET run_at = now() WHERE message_id = $1`, [m.id]);
    await worker.runOnce();
    const retryAfter = await pool.query(`SELECT extract(epoch FROM run_at - now()) AS s FROM push_jobs WHERE message_id = $1`, [m.id]);
    expect(Number(retryAfter.rows[0].s)).toBeGreaterThan(100); // honoured Retry-After: 120
    await pool.query(`UPDATE push_jobs SET run_at = now() WHERE message_id = $1`, [m.id]);
    await worker.runOnce();
    [job] = await jobsFor(m.id);
    expect(job).toMatchObject({ state: 'sent', attempts: 3 });
    expect(inbox(ben.endpoint, ben.sub)).toHaveLength(1);
    expect(webpush.requests.filter((r) => r.path === new URL(ben.endpoint).pathname)).toHaveLength(3);
  });

  it('gives up after the maximum attempts', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    await subscribeBrowser(b);
    webpush.replies.fallback = { status: 500 };
    try {
      const m = await send(a, conv, 'never arrives');
      for (let i = 0; i < 8; i++) {
        await pool.query(`UPDATE push_jobs SET run_at = now() WHERE message_id = $1`, [m.id]);
        await worker.runOnce();
      }
      expect((await jobsFor(m.id))[0]).toMatchObject({ state: 'failed', attempts: 8, last_error: expect.stringMatching(/^gave up after 8 attempts/) });
    } finally {
      webpush.replies.fallback = { status: 201 };
    }
  });

  it('disables an expired subscription and stops queueing for it', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    await subscribeBrowser(b);
    webpush.replies.queue.push({ status: 410 });
    const m = await send(a, conv, 'gone');
    await worker.runOnce();
    expect((await jobsFor(m.id))[0]).toMatchObject({ state: 'failed', last_error: 'token rejected: http 410' });
    const [device] = (await call('GET', '/v1/push/devices', b)).body;
    expect(device).toMatchObject({ deliverable: false, disabledReason: 'http 410' });
    expect(await jobsFor((await send(a, conv, 'again')).id)).toEqual([]);
    // Subscribing again (the browser made a new subscription) re-enables delivery.
    await subscribeBrowser(b);
    expect(await jobsFor((await send(a, conv, 'back')).id)).toHaveLength(1);
  });

  it('recovers a job claimed by a worker that crashed mid-send', async () => {
    const [a, b] = [await user(), await user()];
    const conv = await direct(a, b);
    const ben = await subscribeBrowser(b);
    const m = await send(a, conv, 'survives a crash');
    // What a worker leaves behind if it dies after claiming: a lease and an attempt.
    await pool.query(`UPDATE push_jobs SET locked_until = now() + interval '60 seconds', attempts = 1 WHERE message_id = $1`, [m.id]);
    await worker.runOnce();
    expect(inbox(ben.endpoint, ben.sub)).toEqual([]);
    await pool.query(`UPDATE push_jobs SET locked_until = now() - interval '1 second' WHERE message_id = $1`, [m.id]);
    await worker.runOnce();
    expect(inbox(ben.endpoint, ben.sub)).toHaveLength(1);
    expect((await jobsFor(m.id))[0]).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('never sends a job twice when several API instances run workers', async () => {
    const other = await startApp(pushEnv());
    try {
      const [a, b] = [await user(), await user()];
      const conv = await direct(a, b);
      const ben = await subscribeBrowser(b);
      const sent = [];
      for (let i = 0; i < 30; i++) sent.push(await send(a, conv, `msg ${i}`));
      const workers = [worker, other.app.get(PushWorker), worker, other.app.get(PushWorker)];
      await Promise.all(workers.map((w) => w.runOnce()));
      await Promise.all(workers.map((w) => w.runOnce()));
      const got = inbox(ben.endpoint, ben.sub).map((p) => p.data.messageId);
      expect(got.sort()).toEqual(sent.map((m) => m.id).sort());
      expect(new Set(got).size).toBe(30);
    } finally {
      await other.close();
    }
  });

  it('runs on its own and wakes as soon as a message is sent', async () => {
    const live = await startApp({ ...pushEnv(), PUSH_WORKER_ENABLED: 'true', PUSH_WORKER_INTERVAL_MS: '60000' });
    try {
      const [a, b] = [await registerUser(live.app, 'pushlive'), await registerUser(live.app, 'pushlive')];
      const conv = (await req(live.app, 'POST', '/v1/conversations/direct', { token: a.token, body: { userId: b.id } })).body.id;
      const sub = browserSubscription();
      const endpoint = webpush.endpoint();
      await req(live.app, 'PUT', '/v1/push/devices/current', { token: b.token, body: { provider: 'webpush', endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } } });
      // Let the startup pass finish, so only the wake-up can deliver within the wait below.
      await new Promise((r) => setTimeout(r, 300));
      await req(live.app, 'POST', `/v1/conversations/${conv}/messages`, { token: a.token, body: { clientId: clientId(), body: 'instant' } });
      for (let i = 0; i < 50 && inbox(endpoint, sub).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(inbox(endpoint, sub)).toEqual([expect.objectContaining({ body: 'instant' })]);
    } finally {
      await live.close();
    }
  });
});

describe('account lifecycle', () => {
  it('exports devices and settings without tokens, and deletion removes them', async () => {
    const a = await user();
    const { endpoint } = await subscribeBrowser(a);
    await call('PATCH', '/v1/me/notifications', a, { preview: 'sender' });
    const exp = (await call('GET', '/v1/me/export', a)).body;
    expect(exp.pushDevices).toHaveLength(1);
    expect(exp.notificationSettings).toMatchObject({ preview: 'sender' });
    expect(JSON.stringify(exp)).not.toContain(endpoint);
    expect((await call('DELETE', '/v1/me', a, { password: a.password })).status).toBe(204);
    expect((await pool.query('SELECT 1 FROM push_devices WHERE user_id = $1', [a.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM notification_settings WHERE user_id = $1', [a.id])).rowCount).toBe(0);
  });

  it('deactivation removes devices', async () => {
    const a = await user();
    await subscribeBrowser(a);
    expect((await call('POST', '/v1/me/deactivate', a, { password: a.password })).status).toBe(204);
    expect((await pool.query('SELECT 1 FROM push_devices WHERE user_id = $1', [a.id])).rowCount).toBe(0);
  });
});

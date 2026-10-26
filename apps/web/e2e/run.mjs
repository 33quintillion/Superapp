// End-to-end: real API + real Postgres/Redis + production Next build, driven by Chromium.
// Prereqs: Postgres and Redis running, `pnpm --filter @nexa/api build`, `pnpm --filter @nexa/web build`.
import { spawn } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startSmtpSink } from './smtp-sink.mjs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', '..', 'api');
const API_PORT = 3100, WEB_PORT = 3101, SMTP_PORT = 2525;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

// Web Push is the one push provider that needs no Apple or Google account.
const vapid = createECDH('prime256v1');
vapid.generateKeys();

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://superapp:superapp_dev@localhost:5432/superapp_e2e',
  REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/14',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}`,
  PUBLIC_WEB_URL: WEB,
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  TRUST_PROXY: 'true',
  CORS_ORIGINS: WEB,
  S3_ENDPOINT: process.env.E2E_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  S3_BUCKET: 'nexa-e2e',
  S3_ACCESS_KEY_ID: process.env.E2E_S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.E2E_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_AUTO_CREATE_BUCKET: 'true',
  VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  VAPID_SUBJECT: 'mailto:e2e@example.test',
};

const procs = [];
function run(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  procs.push(p);
  return p;
}
function exec(cmd, args, opts) {
  return new Promise((res, rej) => run(cmd, args, opts).on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${c}`)))));
}
async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

// Smallest valid PNG (1x1).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** Two people chatting in two browsers: live delivery, receipts, typing, offline recovery, media, search. */
async function chatFlow(browser, API, tag, step) {
  const people = [];
  for (const name of ['ana', 'ben']) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'chat passphrase 789', displayName: name === 'ana' ? 'Ana' : 'Ben' };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${people.length + 10}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (process.env.E2E_DEBUG) {
      page.on('console', (m) => console.log(`[${name} console] ${m.text()}`));
      page.on('pageerror', (e) => console.log(`[${name} error] ${e.stack}`));
    }
    await page.goto(`${WEB}/sign-in`);
    await page.fill('input[name=email]', u.email);
    await page.fill('input[name=password]', u.password);
    await page.click('button[type=submit]');
    await page.waitForURL(`${WEB}/account`);
    people.push({ ...u, ctx, page });
  }
  const [ana, ben] = people;
  const bubble = (page, body) => page.locator(`[data-testid=msg][data-body="${body}"]`);

  await ana.page.goto(`${WEB}/chats`);
  await ana.page.waitForSelector('[data-testid=conn]:has-text("Connected")');
  await ana.page.fill('input[name=username]', ben.username);
  await ana.page.click('form.new-chat button');
  await ana.page.waitForSelector(`[data-testid="peer-name"]:has-text("Ben")`);
  await ben.page.goto(`${WEB}/chats`);
  await ben.page.waitForSelector('[data-testid=conn]:has-text("Connected")');
  await ben.page.waitForSelector(`[data-testid="peer-name"]:has-text("Ana")`);
  step('chat opened by username; both browsers connected over WebSocket');

  await ben.page.waitForSelector('[data-testid=presence]:has-text("online")');
  await ana.page.type('input[name=message]', 'hello from ana');
  await ben.page.waitForSelector('[data-testid=typing]');
  step('presence and typing indicator shown live');

  await ana.page.press('input[name=message]', 'Enter');
  await bubble(ben.page, 'hello from ana').waitFor();
  // Ben has the chat open, so it's marked read and Ana's ticks turn to "read".
  await bubble(ana.page, 'hello from ana').locator('[data-testid=ticks].read').waitFor();
  step('message delivered live and read receipt returned');

  await ben.page.fill('input[name=message]', 'hi ana');
  await ben.page.press('input[name=message]', 'Enter');
  await bubble(ana.page, 'hi ana').waitFor();
  step('reply delivered the other way');

  // Ben drops offline. Ana keeps sending; Ben sends too (queued in the outbox).
  await ben.ctx.setOffline(true);
  await ben.page.waitForSelector('[data-testid=conn]:has-text("Offline")');
  for (const body of ['missed one', 'missed two']) {
    await ana.page.fill('input[name=message]', body);
    await ana.page.press('input[name=message]', 'Enter');
    await bubble(ana.page, body).locator('[data-testid=ticks]:not(:has-text("sending"))').waitFor();
  }
  await ben.page.fill('input[name=message]', 'sent while offline');
  await ben.page.press('input[name=message]', 'Enter');
  await bubble(ben.page, 'sent while offline').locator('[data-testid=ticks]:has-text("sending")').waitFor();
  await ben.ctx.setOffline(false);
  await ben.page.waitForSelector('[data-testid=conn]:has-text("Connected")', { timeout: 20000 });
  await bubble(ben.page, 'missed one').waitFor();
  await bubble(ben.page, 'missed two').waitFor();
  await bubble(ana.page, 'sent while offline').waitFor();
  const benBodies = await ben.page.locator('[data-testid=msg]').evaluateAll((els) => els.map((e) => e.dataset.body));
  assert(
    JSON.stringify(benBodies) === JSON.stringify(['hello from ana', 'hi ana', 'missed one', 'missed two', 'sent while offline']),
    `order after reconnect: ${benBodies}`,
  );
  assert((await bubble(ana.page, 'sent while offline').count()) === 1, 'queued message arrives exactly once');
  step('offline device catches up in order; queued send delivered once after reconnect');

  const reactTarget = bubble(ben.page, 'hello from ana');
  await reactTarget.locator('.actions summary').click();
  await reactTarget.locator('button[aria-label="React 👍"]').click();
  await bubble(ana.page, 'hello from ana').locator('[data-testid=reactions]:has-text("👍")').waitFor();
  step('reaction shows up for the sender');

  await ana.page.setInputFiles('[data-testid=file-input]', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  const img = ben.page.locator('[data-testid=media-image]');
  await img.waitFor();
  await ben.page.waitForFunction(() => document.querySelector('[data-testid=media-image]')?.naturalWidth === 1);
  step('photo uploaded straight to object storage and shown to the other person');

  await ben.page.fill('input[name=q]', 'missed');
  await ben.page.press('input[name=q]', 'Enter');
  await ben.page.waitForSelector('[data-testid=search-results] >> text=missed one');
  step('message search');

  const proxied = await ana.page.evaluate(async () => (await fetch('/api/chat/me/export')).status);
  assert(proxied === 404, 'chat proxy only exposes messaging endpoints');
  const csrf = await fetch(`${WEB}/api/chat/conversations/direct`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert(csrf.status === 403, 'cross-site writes through the proxy are refused');
  step('chat proxy is limited to messaging and refuses cross-site writes');

  await notificationsFlow(ana, ben, step);

  for (const p of people) await p.ctx.close();
}

/** Notification settings and the browser service worker handling a push. */
async function notificationsFlow(ana, ben, step) {
  // As if Ben had allowed notifications for this site when asked.
  await ben.ctx.grantPermissions(['notifications'], { origin: WEB });
  await ben.page.goto(`${WEB}/account`);
  await ben.page.waitForFunction(() => document.querySelector('[data-testid=browser-push-state]')?.textContent !== 'Checking…');
  const pushState = await ben.page.textContent('[data-testid=browser-push-state]');
  assert(pushState === 'Off', `browser push offered (state: ${pushState})`);
  await ben.page.selectOption('select[name=preview]', 'sender');
  await ben.page.check('input[name=quiet]');
  await ben.page.fill('input[name=quietStart]', '23:00');
  await ben.page.fill('input[name=quietEnd]', '06:30');
  await ben.page.click('[data-testid=notifications] button[type=submit]');
  await ben.page.waitForSelector('[data-testid=notifications-saved]');
  await ben.page.reload();
  await ben.page.waitForSelector('input[name=quietStart]');
  assert((await ben.page.inputValue('select[name=preview]')) === 'sender', 'preview setting kept');
  assert((await ben.page.inputValue('input[name=quietEnd]')) === '06:30', 'quiet hours kept');
  step('notification settings saved through the proxy and kept after reload');

  // Ana sends while Ben is away from the chat screen (no socket open).
  await ana.page.fill('input[name=message]', 'are you there?');
  await ana.page.press('input[name=message]', 'Enter');
  await ana.page.locator('[data-testid=msg][data-body="are you there?"] [data-testid=ticks]:not(:has-text("sending"))').waitFor();
  const conv = (await ben.page.evaluate(async () => (await fetch('/api/chat/conversations')).json())).conversations[0];
  const before = conv.members.find((m) => m.displayName === 'Ben').lastDeliveredSeq;
  assert(conv.lastMessage.body === 'are you there?' && before < conv.lastMessage.seq, 'not delivered to Ben yet');

  // Hand the service worker a push, as the browser does once it has decrypted one.
  const cdp = await ben.ctx.newCDPSession(ben.page);
  const registered = new Promise((resolve) =>
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const r = registrations.find((x) => x.scopeURL === `${WEB}/` && !x.isDeleted);
      if (r) resolve(r.registrationId);
    }),
  );
  await cdp.send('ServiceWorker.enable');
  await ben.page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  const registrationId = await registered;
  const payload = {
    title: 'Ana',
    body: 'New message',
    tag: conv.id,
    silent: false,
    badge: 1,
    data: { type: 'message', conversationId: conv.id, messageId: conv.lastMessage.id, seq: String(conv.lastMessage.seq) },
  };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: `${WEB}/`, registrationId, data: JSON.stringify(payload) });
  await ben.page.waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).some((n) => n.title === 'Ana'));
  for (let i = 0; i < 40; i++) {
    const c = await ana.page.evaluate(async (id) => (await fetch(`/api/chat/conversations/${id}`)).json(), conv.id);
    if (c.members.find((m) => m.displayName === 'Ben').lastDeliveredSeq >= conv.lastMessage.seq) break;
    assert(i < 39, 'service worker reported the message delivered');
    await new Promise((r) => setTimeout(r, 250));
  }
  step('service worker shows the notification and reports the message delivered');
}

const smtp = await startSmtpSink(SMTP_PORT);
let browser;
let failed = false;
try {
  await exec('node', ['dist/src/database/migrate.cli.js'], { cwd: apiDir, env });
  // Start each run with empty rate-limit counters, as CI does.
  const Redis = createRequire(join(apiDir, 'package.json'))('ioredis');
  const redis = new Redis(env.REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  run('node', ['dist/src/main.js'], { cwd: apiDir, env });
  run('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
    cwd: join(here, '..'),
    env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, API_PUBLIC_WS_URL: `ws://127.0.0.1:${API_PORT}`, NODE_ENV: 'production' },
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/health/ready`);
  await waitFor(`${WEB}/sign-in`);

  // Full Chromium in headless mode: the stripped-down headless shell has no notifications.
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  const tag = randomBytes(4).toString('hex');
  const email = `e2e_${tag}@example.test`;
  const pw1 = 'first passphrase 123', pw2 = 'second passphrase 456';
  const step = (s) => console.log(`  ✓ ${s}`);

  await page.goto(`${WEB}/register`);
  await page.fill('input[name=displayName]', 'E2E Person');
  await page.fill('input[name=username]', `e2e_${tag}`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw1);
  await page.click('button[type=submit]');
  await page.waitForURL(`${WEB}/account`);
  assert((await page.textContent('[data-testid=display-name]')) === 'E2E Person', 'account shows display name');
  assert(await page.isVisible('text=Not confirmed'), 'email starts unconfirmed');
  step('register lands on account page');

  const cookies = await page.context().cookies();
  assert(cookies.find((c) => c.name === 'nexa_rt')?.httpOnly, 'refresh token cookie is httpOnly');
  assert(!(await page.evaluate(() => document.cookie)).includes('nexa_'), 'tokens not readable from JS');
  step('tokens are httpOnly cookies, invisible to page scripts');

  const verify = smtp.messages.find((m) => m.to === email && /Confirm/.test(m.subject));
  assert(verify, 'verification email delivered over SMTP');
  await page.goto(verify.body.match(/https?:\/\/\S+verify-email\?token=\S+/)[0]);
  assert(await page.isVisible('text=Email confirmed'), 'verify link works');
  await page.goto(`${WEB}/account`);
  assert(await page.isVisible('text=Confirmed'), 'account shows confirmed');
  step('email verification link from real SMTP delivery');

  await page.context().clearCookies({ name: 'nexa_at' });
  await page.goto(`${WEB}/account`);
  assert((await page.textContent('[data-testid=display-name]')) === 'E2E Person', 'refresh via middleware');
  step('expired access cookie is refreshed transparently');

  await page.click('text=Sign out of this device');
  await page.waitForURL(/\/sign-in/);
  await page.goto(`${WEB}/account`);
  await page.waitForURL(/\/sign-in/);
  step('sign-out ends the session');

  await page.goto(`${WEB}/forgot-password`);
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=we have sent a link');
  await new Promise((r) => setTimeout(r, 300));
  const reset = smtp.messages.find((m) => m.to === email && /Reset/.test(m.subject));
  assert(reset, 'reset email delivered');
  await page.goto(reset.body.match(/https?:\/\/\S+reset-password\?token=\S+/)[0]);
  await page.fill('input[name=newPassword]', pw2);
  await page.fill('input[name=confirm]', pw2);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Password changed');
  step('password reset via emailed link');

  await page.goto(`${WEB}/sign-in`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw1);
  await page.click('button[type=submit]');
  await page.waitForSelector('p.error');
  assert(/incorrect/.test(await page.textContent('p.error')), 'old password rejected with message');
  assert((await page.inputValue('input[name=email]')) === email, 'email kept after a failed attempt');
  assert((await page.inputValue('input[name=password]')) === '', 'password cleared after a failed attempt');
  await page.fill('input[name=password]', pw2);
  await page.click('button[type=submit]');
  await page.waitForURL(`${WEB}/account`);
  assert((await page.locator('[data-testid=sessions] .row').count()) === 1, 'one live device after reset');
  step('old password refused, new password signs in, one device listed');

  // Turn on two-step through the API using this browser's session, then sign in again in the browser.
  const require = createRequire(import.meta.url);
  const { totp } = require(join(apiDir, 'dist/src/crypto/totp.js'));
  const at = (await page.context().cookies()).find((c) => c.name === 'nexa_at').value;
  const API = `http://127.0.0.1:${API_PORT}`;
  const auth = { authorization: `Bearer ${at}`, 'content-type': 'application/json' };
  const { secret } = await (await fetch(`${API}/v1/auth/mfa/setup`, { method: 'POST', headers: auth, body: '{}' })).json();
  const confirm = await fetch(`${API}/v1/auth/mfa/confirm`, { method: 'POST', headers: auth, body: JSON.stringify({ code: totp(secret, Date.now() - 30_000) }) });
  assert(confirm.status === 204, 'MFA enrolled');
  await page.click('text=Sign out of this device');
  await page.waitForURL(/\/sign-in/);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw2);
  await page.click('button[type=submit]');
  await page.waitForURL(`${WEB}/sign-in/mfa`);
  await page.fill('input[name=code]', '000000');
  await page.click('button[type=submit]');
  await page.waitForSelector('p.error');
  await page.fill('input[name=code]', totp(secret));
  await page.click('button[type=submit]');
  await page.waitForURL(`${WEB}/account`);
  assert(await page.isVisible('text=On'), 'account shows two-step on');
  step('two-step sign-in: wrong code refused, right code accepted');

  await chatFlow(browser, API, tag, step);

  console.log('\nWeb e2e: all checks passed');
} catch (err) {
  failed = true;
  console.error('\nWeb e2e FAILED:', err.message);
} finally {
  await browser?.close();
  smtp.close();
  for (const p of procs) p.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

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
const API_PORT = 3100, WEB_PORT = 3101, SMTP_PORT = 2525, TURN_PORT = 3479, STRIPE_PORT = 12112;
// A real TURN relay (coturn) for the calls flow. Every call is forced through it.
const TURN_SECRET = randomBytes(16).toString('hex');
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
  TURN_PROVIDER: 'coturn',
  TURN_URLS: `turn:127.0.0.1:${TURN_PORT}?transport=udp,turn:127.0.0.1:${TURN_PORT}?transport=tcp`,
  TURN_SHARED_SECRET: TURN_SECRET,
  ICE_TRANSPORT_POLICY: 'relay',
  CALL_RING_SECONDS: '8',
  CALL_CONNECT_SECONDS: '10',
  CALL_SWEEP_INTERVAL_MS: '500',
  // Card payments go to a local stand-in for Stripe's API, with hosted pages and signed webhooks.
  PAYMENTS_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_e2e',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e',
  STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
  PAYMENTS_PLATFORM_FEE_BPS: '500',
  PAYMENTS_SWEEP_INTERVAL_SECONDS: '5',
};

/** coturn with the TURN REST API shared secret, as in production, on loopback only. */
function startTurn() {
  return run(process.env.E2E_TURNSERVER ?? 'turnserver', [
    '-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${TURN_PORT}`,
    '--min-port=49160', '--max-port=49200', '--use-auth-secret', `--static-auth-secret=${TURN_SECRET}`, '--realm=nexa.test',
    '--no-tls', '--no-dtls', '--no-cli', '--allow-loopback-peers', '--fingerprint', '--no-stdout-log', '--log-file=/dev/null',
  ]);
}

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

/** Groups, follows, the feed, stories, private accounts and communities across two browsers. */
async function socialFlow(browser, API, tag, step) {
  const people = {};
  for (const [i, name] of ['cara', 'dev', 'eve'].entries()) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'social passphrase 321', displayName: name[0].toUpperCase() + name.slice(1) };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 40}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    people[name] = { ...u, token: (await r.json()).accessToken };
  }
  for (const name of ['cara', 'dev']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Answers prompt() and confirm() the way a person would.
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Off topic' : undefined));
    if (process.env.E2E_DEBUG) page.on('pageerror', (e) => console.log(`[${name} error] ${e.stack}`));
    await page.goto(`${WEB}/sign-in`);
    await page.fill('input[name=email]', people[name].email);
    await page.fill('input[name=password]', people[name].password);
    await page.click('button[type=submit]');
    await page.waitForURL(`${WEB}/account`);
    Object.assign(people[name], { ctx, page });
  }
  const { cara, dev, eve } = people;

  // Group chat.
  await cara.page.goto(`${WEB}/chats`);
  await cara.page.waitForSelector('[data-testid=conn]:has-text("Connected")');
  await cara.page.click('[data-testid=new-group]');
  await cara.page.fill('input[name=groupTitle]', 'Trip planning');
  await cara.page.fill('input[name=groupMembers]', `${dev.username}, @${eve.username}`);
  await cara.page.click('[data-testid=new-group-form] button[type=submit]');
  await cara.page.waitForSelector('[data-testid=peer-name]:has-text("Trip planning")');
  await cara.page.waitForSelector('[data-testid=system-note]:has-text("You created the group")');
  await dev.page.goto(`${WEB}/chats`);
  await dev.page.waitForSelector('[data-testid=conn]:has-text("Connected")');
  await dev.page.click('[data-testid=conv-group]');
  await dev.page.waitForSelector('[data-testid=system-note]:has-text("Cara created the group")');
  await dev.page.fill('input[name=message]', 'hi group');
  await dev.page.press('input[name=message]', 'Enter');
  const devMsg = cara.page.locator('[data-testid=msg][data-body="hi group"]');
  await devMsg.waitFor();
  assert((await devMsg.locator('.sender').textContent()) === 'Dev', 'group messages show who sent them');
  step('group created from the chat list; members see the notice and each other’s messages');

  await cara.page.click('[data-testid=group-info-toggle]');
  assert((await cara.page.locator('[data-testid=group-member]').count()) === 3, 'three members listed');
  // Controlled by the server's answer, so click and wait rather than check().
  await cara.page.click('input[name=adminsOnlySend]');
  await cara.page.waitForFunction(() => document.querySelector('input[name=adminsOnlySend]')?.checked);
  await dev.page.waitForSelector('[data-testid=admins-only]');
  await cara.page.waitForSelector('[data-testid=system-note]:has-text("You changed the group settings")');
  step('owner switches the group to admins-only; members’ composer closes live');

  // Following and the feed.
  await dev.page.goto(`${WEB}/u/${cara.username}`);
  await dev.page.click('[data-testid=follow-button]');
  await dev.page.waitForSelector('[data-testid=follow-button]:has-text("Following")');
  assert((await dev.page.textContent('[data-testid=follower-count]')) === '1', 'follower count goes up');
  step('follow from a profile page');

  await cara.page.goto(`${WEB}/feed`);
  await cara.page.fill('textarea[name=postBody]', 'Hello followers');
  await cara.page.selectOption('select[name=audience]', 'followers');
  await cara.page.setInputFiles('[data-testid=post-file-input]', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await cara.page.click('[data-testid=post-composer] button[type=submit]');
  await cara.page.waitForSelector('[data-testid=post][data-body="Hello followers"]');
  await dev.page.goto(`${WEB}/feed`);
  const devPost = dev.page.locator('[data-testid=post][data-body="Hello followers"]');
  await devPost.waitFor();
  await dev.page.waitForFunction(() => document.querySelector('[data-testid=post-image]')?.naturalWidth === 1);
  await devPost.locator('[data-testid=like]').click();
  await devPost.locator('[data-testid=like-count]:has-text("1")').waitFor();
  await devPost.locator('[data-testid=comments-toggle]').click();
  await devPost.locator('input[name=comment]').fill('Nice photo!');
  await devPost.locator('input[name=comment]').press('Enter');
  await devPost.locator('[data-testid=comment]:has-text("Nice photo!")').waitFor();
  const eveSees = await fetch(`${API}/v1/users/${(await (await fetch(`${API}/v1/users/${cara.username}`, { headers: { authorization: `Bearer ${eve.token}` } })).json()).id}/posts`, {
    headers: { authorization: `Bearer ${eve.token}` },
  });
  assert((await eveSees.json()).posts.length === 0, 'followers-only post hidden from a non-follower');
  await cara.page.reload();
  await cara.page.locator('[data-testid=post][data-body="Hello followers"] [data-testid=like-count]:has-text("1")').waitFor();
  step('followers-only photo post: follower sees it, likes and comments; non-follower does not');

  // Stories.
  await cara.page.click('button[aria-label="Add to your story"]');
  await cara.page.fill('textarea[name=storyText]', 'Packing for the trip');
  await cara.page.click('[data-testid=story-composer] button[type=submit]');
  await cara.page.waitForSelector('[data-testid=story-composer]', { state: 'detached' });
  await dev.page.reload();
  await dev.page.click('[data-testid=story-ring]');
  await dev.page.waitForSelector('[data-testid=story-viewer]:has-text("Packing for the trip")');
  await dev.page.click('[data-testid=story-viewer] button:has-text("Close")');
  for (let i = 0; i < 20; i++) {
    await cara.page.reload();
    await cara.page.click('[data-testid=story-ring]');
    if ((await cara.page.textContent('[data-testid=story-views]')).includes('1 views')) break;
    assert(i < 19, 'author sees the view count');
    await cara.page.click('[data-testid=story-viewer] button:has-text("Close")');
    await new Promise((r) => setTimeout(r, 250));
  }
  step('text story shared, seen by a follower, and the author sees the view');

  // Private account and follow requests.
  await dev.page.goto(`${WEB}/account`);
  await dev.page.click('input[name=privateAccount]');
  await dev.page.waitForFunction(() => document.querySelector('input[name=privateAccount]')?.checked);
  const devId = (await (await fetch(`${API}/v1/users/${dev.username}`, { headers: { authorization: `Bearer ${eve.token}` } })).json()).id;
  const followed = await (await fetch(`${API}/v1/users/${devId}/follow`, { method: 'POST', headers: { authorization: `Bearer ${eve.token}` } })).json();
  assert(followed.following === 'pending', 'following a private account sends a request');
  await dev.page.reload();
  await dev.page.click('[data-testid=follow-requests] button:has-text("Approve")');
  await dev.page.waitForSelector('[data-testid=follow-requests]', { state: 'detached' });
  const rel = await (await fetch(`${API}/v1/users/${dev.username}`, { headers: { authorization: `Bearer ${eve.token}` } })).json();
  assert(rel.relationship.following === 'active', 'request approved');
  step('private account: follow request approved from the account page');

  // Communities.
  const slug = `trip-${tag}`;
  await cara.page.goto(`${WEB}/communities`);
  await cara.page.click('text=Create a community or channel');
  await cara.page.fill('[data-testid=create-community] input[name=name]', 'Trip club');
  await cara.page.fill('[data-testid=create-community] input[name=slug]', slug);
  await cara.page.selectOption('[data-testid=create-community] select[name=visibility]', 'private');
  await cara.page.click('[data-testid=create-community] button[type=submit]');
  await cara.page.waitForURL(`${WEB}/communities/${slug}`);
  await dev.page.goto(`${WEB}/communities/${slug}`);
  await dev.page.click('[data-testid=join]');
  await dev.page.waitForSelector('[data-testid=join-pending]');
  await cara.page.reload();
  await cara.page.click('[data-testid=approve]');
  await cara.page.waitForSelector('[data-testid=pending-member]', { state: 'detached' });
  await dev.page.reload();
  await dev.page.fill('textarea[name=postBody]', 'Selling my old tent');
  await dev.page.click('[data-testid=post-composer] button[type=submit]');
  await dev.page.waitForSelector('[data-testid=post][data-body="Selling my old tent"]');
  await cara.page.reload();
  const offTopic = cara.page.locator('[data-testid=post][data-body="Selling my old tent"]');
  await offTopic.locator('.actions summary').click();
  await offTopic.locator('[data-testid=moderate-post]').click();
  await offTopic.waitFor({ state: 'detached' });
  await dev.page.reload();
  await dev.page.waitForSelector('[data-testid=post-removed]:has-text("Off topic")');
  step('private community: join request approved, member posts, moderator removes it with a reason');

  for (const p of [cara, dev]) await p.ctx.close();
}

/**
 * Voice and video calls between two real Chromium browsers with fake camera and
 * microphone devices. ICE_TRANSPORT_POLICY=relay, so media only flows if the browsers
 * authenticate to the local coturn with the API's credentials and relay through it.
 */
async function callsFlow(browser, API, tag, step, turn) {
  const people = {};
  for (const [i, name] of ['dan', 'fay'].entries()) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'calling passphrase 654', displayName: name === 'dan' ? 'Dan' : 'Fay' };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 60}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['camera', 'microphone'], { origin: WEB });
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
    people[name] = { ...u, ctx, page };
  }
  const { dan, fay } = people;
  await dan.page.goto(`${WEB}/chats`);
  await dan.page.waitForSelector('[data-testid=conn]:has-text("Connected")');
  await dan.page.fill('input[name=username]', fay.username);
  await dan.page.click('form.new-chat button');
  await dan.page.waitForSelector('[data-testid="peer-name"]:has-text("Fay")');
  await fay.page.goto(`${WEB}/chats`);
  await fay.page.waitForSelector('[data-testid=conn]:has-text("Connected")');

  // Media is really flowing when the remote <video> has a picture and keeps playing.
  const videoPlaying = (page) =>
    page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid=remote-video]');
        if (!v || !v.videoWidth) return false;
        const t = Number(v.dataset.seenTime ?? -1);
        v.dataset.seenTime = String(v.currentTime);
        return t >= 0 && v.currentTime > t;
      },
      null,
      { timeout: 20000, polling: 500 },
    );
  const phase = (page, p) => page.waitForSelector(`[data-testid=in-call][data-phase=${p}]`, { timeout: 20000 });

  await dan.page.click('[data-testid=video-call]');
  await dan.page.waitForSelector('[data-testid=call-status]:has-text("Ringing")');
  await fay.page.waitForSelector('[data-testid=incoming-call]:has-text("Dan")');
  await fay.page.waitForSelector('[data-testid=incoming-call]:has-text("Incoming video call")');
  step('video call rings the other browser');

  await fay.page.click('[data-testid=accept-call]');
  await phase(dan.page, 'active');
  await phase(fay.page, 'active');
  await videoPlaying(dan.page);
  await videoPlaying(fay.page);
  for (const p of [dan.page, fay.page]) await p.waitForSelector('[data-testid=call-route][data-route=relay]', { timeout: 10000 });
  step('answered: camera video plays both ways, relayed through coturn with API-issued TURN credentials');

  await dan.page.click('[data-testid=mute]');
  assert(await dan.page.evaluate(() => document.querySelector('[data-testid=local-video]').srcObject.getAudioTracks().every((t) => !t.enabled)), 'mute disables the microphone track');
  await dan.page.click('[data-testid=camera]');
  await dan.page.waitForSelector('[data-testid=local-video]', { state: 'detached' });
  await dan.page.click('[data-testid=camera]');
  await dan.page.click('[data-testid=mute]');
  assert(await dan.page.evaluate(() => document.querySelector('[data-testid=local-video]').srcObject.getTracks().every((t) => t.enabled)), 'unmute and camera on');
  step('mute and camera controls switch the local tracks');

  // Fay's browser loses its connection to the server for a moment. The call keeps its
  // place, her browser resumes on a new socket, and Dan restarts ICE.
  await fay.ctx.setOffline(true);
  await fay.page.waitForSelector('[data-testid=conn]:has-text("Offline")');
  await dan.page.waitForSelector('[data-testid=in-call][data-phase=reconnecting]', { timeout: 10000 });
  await fay.ctx.setOffline(false);
  await fay.page.waitForSelector('[data-testid=conn]:has-text("Connected")', { timeout: 20000 });
  await phase(dan.page, 'active');
  await videoPlaying(dan.page);
  await videoPlaying(fay.page);
  step('signalling connection drops mid-call and the call recovers');

  await dan.page.click('[data-testid=hangup]');
  await dan.page.waitForSelector('[data-testid=call-ended]:has-text("Call ended")');
  await fay.page.waitForSelector('[data-testid=call-ended]:has-text("Call ended")');
  await dan.page.waitForSelector('[data-testid=system-note]:has-text("Video call ·")');
  await fay.page.waitForSelector('[data-testid=system-note]:has-text("Video call ·")');
  assert(await dan.page.evaluate(() => !document.querySelector('[data-testid=in-call]')), 'call screen closed');
  step('hang up ends the call for both; the chat shows the call and its length');

  await fay.page.click('[data-testid=voice-call]');
  await dan.page.waitForSelector('[data-testid=incoming-call]:has-text("Incoming voice call")');
  await dan.page.click('[data-testid=decline-call]');
  await fay.page.waitForSelector('[data-testid=call-ended]:has-text("Dan declined the call")');
  await dan.page.waitForSelector('[data-testid=system-note]:has-text("You declined a voice call")');
  step('declined voice call');

  await dan.page.click('[data-testid=voice-call]');
  await fay.page.waitForSelector('[data-testid=incoming-call]');
  await dan.page.waitForSelector('[data-testid=call-ended]:has-text("No answer")', { timeout: 20000 });
  await fay.page.waitForSelector('[data-testid=incoming-call]', { state: 'detached' });
  await fay.page.waitForSelector('[data-testid=system-note]:has-text("Missed voice call")');
  await fay.page.click('[data-testid=calls-toggle]');
  await fay.page.waitForSelector('[data-testid=call-row][data-outcome=missed]:has-text("Dan")');
  assert((await fay.page.locator('[data-testid=call-row]').count()) === 3, 'three calls in history');
  await fay.page.click('[data-testid=calls-toggle]');
  step('unanswered call rings out: "No answer" for the caller, a missed call in chat and history for the callee');

  // Microphone blocked in the browser: nothing rings, and the person is told why.
  await fay.ctx.clearPermissions();
  await fay.page.click('[data-testid=voice-call]');
  await fay.page.waitForSelector('[data-testid=call-ended]:has-text("Allow access to your microphone")');
  assert(!(await dan.page.isVisible('[data-testid=incoming-call]')), 'no call placed without a microphone');
  // Answering with the camera blocked: the call keeps ringing with an explanation.
  await dan.page.click('[data-testid=video-call]');
  await fay.page.waitForSelector('[data-testid=incoming-call]');
  await fay.page.click('[data-testid=accept-call]');
  await fay.page.waitForSelector('[data-testid=call-notice]:has-text("Allow access to your camera and microphone")');
  await fay.page.click('[data-testid=decline-call]');
  await dan.page.waitForSelector('[data-testid=call-ended]:has-text("Fay declined the call")');
  await fay.ctx.grantPermissions(['camera', 'microphone'], { origin: WEB });
  step('microphone or camera permission denied: explained, and no broken call');

  // The TURN relay goes down. Relay-only calls cannot connect, and both sides are told.
  turn.kill('SIGTERM');
  await new Promise((r) => turn.once('exit', r));
  await dan.page.click('[data-testid=video-call]');
  await fay.page.click('[data-testid=accept-call]');
  await dan.page.waitForSelector('[data-testid=call-ended]:has-text("Call failed")', { timeout: 30000 });
  await fay.page.waitForSelector('[data-testid=call-ended]:has-text("Call failed")', { timeout: 30000 });
  step('relay unreachable: the call fails cleanly on both sides');

  for (const p of [dan, fay]) await p.ctx.close();
}

/** Businesses, orders, bookings, the integration catalogue and the admin dashboard, across five browsers. */
async function businessFlow(browser, API, tag, step) {
  const require = createRequire(import.meta.url);
  const { totp } = require(join(apiDir, 'dist/src/crypto/totp.js'));
  const { Pool } = createRequire(join(apiDir, 'package.json'))('pg');
  const people = {};
  for (const [i, name] of ['gus', 'hal', 'ivy', 'jo'].entries()) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'business passphrase 654', displayName: name[0].toUpperCase() + name.slice(1) };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 70}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    people[name] = { ...u, token: (await r.json()).accessToken };
  }
  // Jo is platform staff: two-step on, admin role granted from the command line's code path.
  const { jo } = people;
  const auth = { authorization: `Bearer ${jo.token}`, 'content-type': 'application/json' };
  const { secret } = await (await fetch(`${API}/v1/auth/mfa/setup`, { method: 'POST', headers: auth, body: '{}' })).json();
  assert((await fetch(`${API}/v1/auth/mfa/confirm`, { method: 'POST', headers: auth, body: JSON.stringify({ code: totp(secret, Date.now() - 30_000) }) })).status === 204, 'admin MFA on');
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  await pool.query(`INSERT INTO platform_staff (user_id, role) SELECT id, 'admin' FROM users WHERE email = $1`, [jo.email]);
  await pool.end();

  for (const name of ['gus', 'hal', 'ivy', 'jo']) {
    const ctx = await browser.newContext({ timezoneId: 'UTC' });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Under investigation' : undefined));
    if (process.env.E2E_DEBUG) page.on('pageerror', (e) => console.log(`[${name} error] ${e.stack}`));
    await page.goto(`${WEB}/sign-in`);
    await page.fill('input[name=email]', people[name].email);
    await page.fill('input[name=password]', people[name].password);
    await page.click('button[type=submit]');
    if (name === 'jo') {
      await page.waitForURL(`${WEB}/sign-in/mfa`);
      await page.fill('input[name=code]', totp(secret));
      await page.click('button[type=submit]');
    }
    await page.waitForURL(`${WEB}/account`);
    Object.assign(people[name], { ctx, page });
  }
  const { gus, hal, ivy } = people;
  const handle = `bakery-${tag}`;

  // Gus opens a bakery.
  await gus.page.goto(`${WEB}/business`);
  await gus.page.click('text=Add your business');
  await gus.page.fill('[data-testid=create-business] input[name=name]', 'Sunrise Bakery');
  await gus.page.fill('[data-testid=create-business] input[name=handle]', handle);
  await gus.page.fill('[data-testid=create-business] input[name=currency]', 'EUR');
  await gus.page.fill('[data-testid=create-business] input[name=timeZone]', 'UTC');
  await gus.page.click('[data-testid=create-business] button[type=submit]');
  await gus.page.waitForURL(`${WEB}/business/${handle}`);
  await gus.page.waitForSelector('[data-testid=my-role]:has-text("owner")');
  await gus.page.click('role=tab[name="Settings"]');
  await gus.page.click('input[name=ordersEnabled]');
  await gus.page.waitForFunction(() => document.querySelector('input[name=ordersEnabled]')?.checked);
  await gus.page.click('input[name=bookingsEnabled]');
  await gus.page.waitForFunction(() => document.querySelector('input[name=bookingsEnabled]')?.checked);
  await gus.page.click('role=tab[name="Catalogue"]');
  for (const [name, price, stock] of [['Sourdough', '4.50', '10'], ['Croissant', '1.80', '']]) {
    await gus.page.fill('[data-testid=add-item] input[name=name]', name);
    await gus.page.fill('[data-testid=add-item] input[name=price]', price);
    await gus.page.fill('[data-testid=add-item] input[name=stock]', stock);
    await gus.page.click('[data-testid=add-item] button[type=submit]');
    await gus.page.waitForSelector(`[data-testid=catalogue-item]:has-text("${name}")`);
  }
  await gus.page.click('role=tab[name="Services and hours"]');
  await gus.page.fill('[data-testid=add-service] input[name=name]', 'Cake tasting');
  await gus.page.fill('[data-testid=add-service] input[name=duration]', '60');
  await gus.page.click('[data-testid=add-service] button[type=submit]');
  await gus.page.waitForSelector('[data-testid=service]:has-text("Cake tasting")');
  await gus.page.click('text=Add opening time');
  const tomorrowDay = new Date(Date.now() + 86400_000).getUTCDay();
  await gus.page.selectOption('[data-testid=hours-row] select', String(tomorrowDay));
  await gus.page.click('[data-testid=save-hours]');
  await gus.page.waitForSelector('[data-testid=hours-saved]');
  step('owner creates a business, turns on orders and bookings, adds items, a service and opening hours');

  // Hal is invited as staff and only gets the tabs staff may use.
  await gus.page.click('role=tab[name="Staff"]');
  await gus.page.fill('[data-testid=invite-staff] input[name=username]', hal.username);
  await gus.page.click('[data-testid=invite-staff] button[type=submit]');
  await gus.page.waitForSelector('[data-testid=staff-member]:has-text("Invited")');
  await hal.page.goto(`${WEB}/business`);
  await hal.page.click('[data-testid=business-invite] button:has-text("Accept")');
  await hal.page.click(`[data-testid=business-row][href="/business/${handle}"]`);
  await hal.page.waitForSelector('[data-testid=my-role]:has-text("staff")');
  const halTabs = await hal.page.locator('role=tab').allTextContents();
  assert(JSON.stringify(halTabs) === JSON.stringify(['Orders', 'Bookings', 'Staff']), `staff tabs ${halTabs}`);
  assert((await hal.page.locator('[data-testid=invite-staff]').count()) === 0 || !(await hal.page.isVisible('[data-testid=invite-staff]')), 'staff cannot invite');
  const forbidden = await hal.page.evaluate(async (id) => (await fetch(`/api/chat/businesses/${id}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', priceMinor: 1 }) })).status,
    await gus.page.evaluate(async (h) => (await (await fetch(`/api/chat/businesses/${h}`)).json()).id, handle));
  assert(forbidden === 403, `staff adding an item is refused (${forbidden})`);
  step('invited staff accept, see only orders, bookings and staff, and are refused catalogue changes');

  // Ivy finds the bakery, orders and books.
  await ivy.page.goto(`${WEB}/business`);
  await ivy.page.fill('input[name=businessSearch]', 'Sunrise');
  await ivy.page.click('form.composer-row button');
  await ivy.page.click(`[data-testid=business-results] a[href="/b/${handle}"]`);
  await ivy.page.waitForURL(`${WEB}/b/${handle}`);
  await ivy.page.click('[aria-label="Add Sourdough"]');
  await ivy.page.click('[aria-label="Add Sourdough"]');
  await ivy.page.click('[aria-label="Add Croissant"]');
  assert((await ivy.page.textContent('[data-testid=basket-total]')) === '€10.80', `basket total ${await ivy.page.textContent('[data-testid=basket-total]')}`);
  await ivy.page.fill('[data-testid=basket] input[name=note]', 'Sliced please');
  await ivy.page.click('[data-testid=basket] button[type=submit]');
  await ivy.page.waitForSelector('[data-testid=order-placed]:has-text("Waiting for the business")');
  await ivy.page.waitForSelector('[data-testid=slot]');
  const firstSlot = await ivy.page.locator('[data-testid=slot]').first().textContent();
  assert(firstSlot === '09:00', `first slot ${firstSlot}`);
  await ivy.page.locator('[data-testid=slot]').first().click();
  await ivy.page.waitForSelector('[data-testid=booked]:has-text("Cake tasting")');
  await ivy.page.waitForFunction(() => document.querySelector('[data-testid=slot]')?.textContent === '10:00');
  step('customer finds the business, orders for pickup with the right total, and books the 09:00 slot, which then disappears');

  // Hal works the order through to collection.
  await hal.page.reload();
  await hal.page.waitForSelector('[data-testid=order]:has-text("Sliced please")');
  for (const label of ['Accept', 'Mark ready', 'Collected']) {
    await hal.page.click(`[data-testid=order] button:has-text("${label}")`);
    if (label !== 'Collected') await hal.page.waitForSelector(`[data-testid=order] button:has-text("${label === 'Accept' ? 'Mark ready' : 'Collected'}")`);
  }
  await hal.page.waitForSelector('[data-testid=orders-tab] >> text=No orders here.');
  await hal.page.click('role=tab[name="Bookings"]');
  await hal.page.waitForSelector('[data-testid=business-booking]:has-text("Cake tasting")');
  step('staff accept, ready and complete the order, and see the booking');

  await ivy.page.goto(`${WEB}/orders`);
  await ivy.page.waitForSelector('[data-testid=my-order][data-status=completed]:has-text("Collected")');
  await ivy.page.click('[data-testid=my-booking] button:has-text("Cancel")');
  await ivy.page.waitForSelector('[data-testid=my-booking][data-status=cancelled]');
  step('customer sees the order collected, and cancels the booking');

  // Ivy reports the bakery; Jo works the report in the admin dashboard.
  await ivy.page.goto(`${WEB}/b/${handle}`);
  await ivy.page.click('text=Report this business');
  await ivy.page.fill('input[name=details]', 'Took my money, no bread');
  await ivy.page.click('text=Send report');
  await ivy.page.waitForSelector('text=Thanks, our team will look at it.');
  const ivyAdmin = await ivy.page.goto(`${WEB}/admin`);
  assert(ivyAdmin.status() === 200, 'admin page renders');
  await ivy.page.waitForSelector('[data-testid=admin-refused][data-code=not_platform_staff]');
  await jo.page.goto(`${WEB}/account`);
  await jo.page.click('[data-testid=staff-access] >> text=Open the admin dashboard');
  await jo.page.waitForSelector('[data-testid=admin-overview]:has-text("You: admin")');
  await jo.page.click('[data-testid=report-row][data-subject=business]:has-text("Took my money")');
  await jo.page.waitForSelector('[data-testid=subject]:has-text("Sunrise Bakery")');
  await jo.page.fill('input[name=resolutionNote]', 'Fraud reports');
  await jo.page.click('[data-testid=remove-content]');
  await jo.page.waitForSelector('[data-testid=report-detail][data-status=actioned]');
  const gone = await ivy.page.goto(`${WEB}/b/${handle}`);
  assert(gone.status() === 404, `suspended business hidden (${gone.status()})`);
  await gus.page.reload();
  await gus.page.waitForSelector('[data-testid=suspended]:has-text("Fraud reports")');
  step('non-staff are refused the admin dashboard; an admin signed in with two-step suspends the reported business, which customers can no longer see');

  await jo.page.click('role=tab[name="Audit log"]');
  await jo.page.waitForSelector('[data-testid=audit-entry][data-action="admin.report.actioned"]');
  await jo.page.click('role=tab[name="Businesses"]');
  await jo.page.click(`[data-testid=admin-business][data-handle="${handle}"] button:has-text("Restore")`);
  await jo.page.waitForSelector(`[data-testid=admin-business][data-handle="${handle}"][data-state=active]`);
  step('the audit log shows the action, and the admin restores the business');

  // The integration catalogue and its kill switch.
  await jo.page.click('role=tab[name="Integrations"]');
  const slug = `tickets-${tag}`;
  await jo.page.fill('[data-testid=new-integration] input[name=name]', 'City Tickets');
  await jo.page.fill('[data-testid=new-integration] input[name=slug]', slug);
  await jo.page.fill('[data-testid=new-integration] input[name=developerName]', 'Tickets Ltd');
  await jo.page.fill('[data-testid=new-integration] input[name=developerContact]', 'dev@tickets.test');
  await jo.page.fill('[data-testid=new-integration] input[name=homepageUrl]', 'https://tickets.test');
  await jo.page.check('[data-testid=new-integration] input[value="profile.basic"]');
  await jo.page.check('[data-testid=new-integration] input[value="email"]');
  await jo.page.click('[data-testid=new-integration] button[type=submit]');
  await jo.page.click(`[data-testid=admin-integration][data-slug="${slug}"] button:has-text("Approve and publish")`);
  await jo.page.waitForSelector(`[data-testid=admin-integration][data-slug="${slug}"][data-state=live]`);
  await ivy.page.goto(`${WEB}/apps`);
  await ivy.page.click('[data-testid=catalogue-app]:has-text("City Tickets") button:has-text("Connect")');
  await ivy.page.uncheck('[data-testid=consent] input[value=email]');
  await ivy.page.click('[data-testid=consent] button[type=submit]');
  await ivy.page.waitForSelector('[data-testid=connected-app]:has-text("City Tickets")');
  const shown = await ivy.page.textContent('[data-testid=connected-app]');
  assert(shown.includes('display name') && !shown.includes('email'), `granted scopes shown: ${shown}`);
  await jo.page.click(`[data-testid=admin-integration][data-slug="${slug}"] [data-testid=kill-switch]`);
  await jo.page.waitForSelector(`[data-testid=admin-integration][data-slug="${slug}"][data-state=disabled]`);
  await ivy.page.reload();
  await ivy.page.waitForSelector('[data-testid=connected-app]:has-text("Paused by Nexa")');
  assert((await ivy.page.locator('[data-testid=catalogue-app]:has-text("City Tickets")').count()) === 0, 'switched-off integration leaves the catalogue');
  step('an admin publishes an integration, a person connects it with only the scopes they tick, and the kill switch pauses it');

  for (const p of Object.values(people)) await p.ctx.close();
}

/**
 * Card payments against the local Stripe stand-in: payouts setup, paying on the hosted page,
 * a partial refund, a business plan bought through hosted checkout, and a balanced ledger.
 */
async function paymentsFlow(browser, API, tag, step) {
  const require = createRequire(import.meta.url);
  const { totp } = require(join(apiDir, 'dist/src/crypto/totp.js'));
  const { Pool } = createRequire(join(apiDir, 'package.json'))('pg');
  const people = {};
  for (const [i, name] of ['kim', 'lee', 'max'].entries()) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'payments passphrase 987', displayName: name[0].toUpperCase() + name.slice(1) };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 90}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    people[name] = { ...u, token: (await r.json()).accessToken };
  }
  const { max } = people;
  const maxAuth = { authorization: `Bearer ${max.token}`, 'content-type': 'application/json' };
  const { secret } = await (await fetch(`${API}/v1/auth/mfa/setup`, { method: 'POST', headers: maxAuth, body: '{}' })).json();
  assert((await fetch(`${API}/v1/auth/mfa/confirm`, { method: 'POST', headers: maxAuth, body: JSON.stringify({ code: totp(secret, Date.now() - 30_000) }) })).status === 204, 'admin MFA on');
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  await pool.query(`INSERT INTO platform_staff (user_id, role) SELECT id, 'admin' FROM users WHERE email = $1`, [max.email]);
  await pool.end();

  // The owner's shop, set up through the API: the browser part of that is covered by the business flow.
  const kimAuth = { authorization: `Bearer ${people.kim.token}`, 'content-type': 'application/json' };
  const handle = `deli-${tag}`;
  const b = await (await fetch(`${API}/v1/businesses`, { method: 'POST', headers: kimAuth, body: JSON.stringify({ handle, name: 'Corner Deli', category: 'food', timeZone: 'UTC', currency: 'GBP' }) })).json();
  assert((await fetch(`${API}/v1/businesses/${b.id}`, { method: 'PATCH', headers: kimAuth, body: JSON.stringify({ ordersEnabled: true }) })).ok, 'orders on');
  assert((await fetch(`${API}/v1/businesses/${b.id}/items`, { method: 'POST', headers: kimAuth, body: JSON.stringify({ name: 'Bagel', priceMinor: 350 }) })).ok, 'item added');

  for (const name of ['kim', 'lee', 'max']) {
    const ctx = await browser.newContext({ timezoneId: 'UTC' });
    const page = await ctx.newPage();
    if (process.env.E2E_DEBUG) page.on('pageerror', (e) => console.log(`[${name} error] ${e.stack}`));
    await page.goto(`${WEB}/sign-in`);
    await page.fill('input[name=email]', people[name].email);
    await page.fill('input[name=password]', people[name].password);
    await page.click('button[type=submit]');
    if (name === 'max') {
      await page.waitForURL(`${WEB}/sign-in/mfa`);
      await page.fill('input[name=code]', totp(secret));
      await page.click('button[type=submit]');
    }
    await page.waitForURL(`${WEB}/account`);
    Object.assign(people[name], { ctx, page });
  }
  const { kim, lee } = people;

  // Before payouts are set up, customers can only pay at pickup.
  await lee.page.goto(`${WEB}/b/${handle}`);
  await lee.page.click('[aria-label="Add Bagel"]');
  assert((await lee.page.locator('[data-testid=payment-choice]').count()) === 0, 'no card option before payouts are set up');

  await kim.page.goto(`${WEB}/business/${handle}?tab=payments`);
  await kim.page.waitForSelector('[data-testid=payouts-not-ready]');
  await kim.page.click('[data-testid=setup-payouts]');
  await kim.page.waitForSelector('[data-testid=onboarding-finish]');
  assert(kim.page.url().startsWith(stripe.url), `onboarding is on the provider's page (${kim.page.url()})`);
  await kim.page.click('[data-testid=onboarding-finish]');
  await kim.page.waitForURL(new RegExp(`/business/${handle}\\?tab=payments`));
  await kim.page.waitForSelector('[data-testid=payouts-ready]');
  step('owner sets up payouts on the provider’s hosted page and comes back ready to take cards');

  await lee.page.goto(`${WEB}/b/${handle}`);
  await lee.page.click('[aria-label="Add Bagel"]');
  await lee.page.click('[aria-label="Add Bagel"]');
  await lee.page.check('input[name=payment][value=online]');
  await lee.page.click('[data-testid=basket] button:has-text("Continue to payment")');
  await lee.page.waitForSelector('[data-testid=checkout-total]');
  assert(lee.page.url().startsWith(stripe.url), 'card details are taken on the provider’s page');
  assert((await lee.page.textContent('[data-testid=checkout-total]')).includes('7.00'), `checkout total ${await lee.page.textContent('[data-testid=checkout-total]')}`);
  await lee.page.click('[data-testid=checkout-pay]');
  await lee.page.waitForURL(/\/orders\?paid=/);
  await lee.page.waitForSelector('[data-testid=payment-result][data-status=paid]');
  await lee.page.waitForSelector('[data-testid=my-order][data-payment=paid]');
  step('customer pays by card on the hosted checkout, the signed webhook confirms it, and the order shows paid');

  await kim.page.click('role=tab[name="Orders"]');
  await kim.page.waitForSelector('[data-testid=order] [data-testid=order-payment]:has-text("Paid online")');
  await kim.page.click('[data-testid=order] button:has-text("Refund")');
  await kim.page.fill('[data-testid=refund-form] input[name=amount]', '2.00');
  await kim.page.fill('[data-testid=refund-form] input[name=reason]', 'One bagel was stale');
  await kim.page.click('[data-testid=refund-form] button[type=submit]');
  await kim.page.waitForSelector('[data-testid=order]:has-text("£2.00 refunded")');
  await lee.page.reload();
  await lee.page.waitForSelector('[data-testid=my-order][data-payment=partially_refunded]');
  step('owner refunds part of the order and the customer sees it partly refunded');

  await max.page.goto(`${WEB}/admin`);
  await max.page.click('role=tab[name="Payments and plans"]');
  const code = `growth-${tag}`;
  await max.page.fill('[data-testid=new-plan] input[name=code]', code);
  await max.page.fill('[data-testid=new-plan] input[name=name]', 'Growth');
  await max.page.fill('[data-testid=new-plan] input[name=price]', '15.00');
  await max.page.click('[data-testid=new-plan] button[type=submit]');
  await max.page.waitForSelector(`[data-testid=admin-plan][data-code="${code}"][data-state=draft]`);
  await max.page.click(`[data-testid=admin-plan][data-code="${code}"] button:has-text("Put on sale")`);
  await max.page.waitForSelector(`[data-testid=admin-plan][data-code="${code}"][data-state=active]`);

  await kim.page.click('role=tab[name="Payments and plan"]');
  await kim.page.waitForSelector('[data-testid=limits]:has-text("Up to 10 staff")');
  await kim.page.click(`[data-testid=plan-option][data-code="${code}"] button:has-text("Choose")`);
  await kim.page.waitForSelector('[data-testid=checkout-pay]');
  await kim.page.click('[data-testid=checkout-pay]');
  await kim.page.waitForURL(/subscribed=1/);
  for (let i = 0; i < 20 && !(await kim.page.isVisible('[data-testid=current-plan][data-status=active]')); i++) {
    await new Promise((r) => setTimeout(r, 500));
    await kim.page.reload();
  }
  await kim.page.waitForSelector('[data-testid=current-plan][data-status=active]:has-text("Growth")');
  await kim.page.waitForSelector('[data-testid=limits]:has-text("Up to 100 staff")');
  step('admin creates a plan and puts it on sale; the owner subscribes through hosted checkout and gets the higher limits');

  await max.page.reload();
  await max.page.click('role=tab[name="Payments and plans"]');
  await max.page.waitForSelector('[data-testid=ledger-check][data-ok=true]');
  assert((await max.page.locator('[data-testid=admin-payments] .row').count()) >= 1, 'admin sees the card payment');
  step('the ledger balances and agrees with every payment, refund and subscription invoice');

  for (const p of Object.values(people)) await p.ctx.close();
}

/**
 * Accessibility audit (Stage 9): axe-core's WCAG 2.2 A and AA rules on every screen, in light
 * and dark mode, with real data on them; plus keyboard checks and the Content Security Policy.
 */
async function a11yFlow(browser, API, tag, step) {
  const require = createRequire(import.meta.url);
  const { totp } = require(join(apiDir, 'dist/src/crypto/totp.js'));
  const { Pool } = createRequire(join(apiDir, 'package.json'))('pg');
  const axeSource = (await import('node:fs')).readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const people = {};
  for (const [i, name] of ['amy', 'bob'].entries()) {
    const u = { email: `${name}_${tag}@example.test`, username: `${name}_${tag}`, password: 'a11y passphrase 2468', displayName: name === 'amy' ? 'Amy' : 'Bob' };
    const r = await fetch(`${API}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 120}` },
      body: JSON.stringify(u),
    });
    assert(r.status === 201, `register ${name}`);
    const pair = await r.json();
    people[name] = { ...u, token: pair.accessToken };
  }
  const { amy, bob } = people;
  const as = (p) => ({ authorization: `Bearer ${p.token}`, 'content-type': 'application/json' });
  const call = async (p, method, path, body) => {
    const headers = body ? as(p) : { authorization: as(p).authorization };
    const r = await fetch(`${API}/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    assert(r.ok, `${method} ${path}: ${r.status} ${await r.clone().text()}`);
    return r.status === 204 ? null : r.json();
  };
  // Amy is an admin, so the dashboard is audited too.
  const { secret } = await call(amy, 'POST', '/auth/mfa/setup', {});
  await call(amy, 'POST', '/auth/mfa/confirm', { code: totp(secret, Date.now() - 30_000) });
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  await pool.query(`INSERT INTO platform_staff (user_id, role) SELECT id, 'admin' FROM users WHERE email = $1`, [amy.email]);
  await pool.end();
  // Something on every screen: a chat, posts, a follow, a community, a business with an item, a report.
  const bobMe = await call(bob, 'GET', '/me');
  const amyMe = await call(amy, 'GET', '/me');
  const conv = await call(amy, 'POST', '/conversations/direct', { userId: bobMe.id });
  for (const [p, body] of [[amy, 'Hi Bob, are we still on for lunch?'], [bob, 'Yes, see you at noon'], [amy, 'Great']]) {
    await call(p, 'POST', `/conversations/${conv.id}/messages`, { clientId: `a11y${randomBytes(6).toString('hex')}`, body });
  }
  await call(bob, 'POST', `/users/${amyMe.id}/follow`);
  await call(amy, 'POST', '/posts', { clientId: `a11y${randomBytes(6).toString('hex')}`, body: 'First post from the accessibility audit' });
  const slug = `audit-${tag}`;
  await call(amy, 'POST', '/communities', { slug, name: 'Accessible Things', description: 'A community for the audit' });
  const handle = `audit-bakery-${tag}`;
  const biz = await call(amy, 'POST', '/businesses', { handle, name: 'Audit Bakery', category: 'food', timeZone: 'UTC', currency: 'GBP' });
  await call(amy, 'PATCH', `/businesses/${biz.id}`, { ordersEnabled: true });
  await call(amy, 'POST', `/businesses/${biz.id}/items`, { name: 'Sourdough', priceMinor: 450, description: 'Baked this morning' });
  await call(bob, 'POST', '/reports', { subjectType: 'user', subjectId: amyMe.id, reason: 'spam', details: 'Audit report' });

  const signIn = async (page, p, mfa) => {
    await page.goto(`${WEB}/sign-in`);
    await page.fill('input[name=email]', p.email);
    await page.fill('input[name=password]', p.password);
    await page.click('button[type=submit]');
    if (mfa) {
      await page.waitForURL(`${WEB}/sign-in/mfa`);
      await page.fill('input[name=code]', totp(secret));
      await page.click('button[type=submit]');
    }
    await page.waitForURL(`${WEB}/account`);
  };

  const failures = [];
  const audited = [];
  async function audit(page, label) {
    await page.evaluate(axeSource);
    const res = await page.evaluate(async () =>
      // eslint-disable-next-line no-undef
      axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] }),
    );
    for (const v of res.violations) {
      failures.push(`${label}: [${v.impact}] ${v.id} (${v.help}) at ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    }
    audited.push(label);
  }

  const screens = [
    ['sign-in', null, '/sign-in', 'form'],
    ['register', null, '/register', 'form'],
    ['forgot password', null, '/forgot-password', 'form'],
    ['reset password', null, '/reset-password?token=not-a-real-token', 'main'],
    ['verify email (bad link)', null, '/verify-email?token=not-a-real-token', 'main'],
    ['account', 'amy', '/account', '[data-testid=display-name]'],
    ['feed', 'amy', '/feed', 'text=First post from the accessibility audit'],
    ['chats', 'amy', '/chats', '[data-testid=conn]:has-text("Connected")'],
    ['profile', 'amy', `/u/${bob.username}`, 'main h1'],
    ['communities', 'amy', '/communities', 'text=Accessible Things'],
    ['community', 'amy', `/communities/${slug}`, 'text=A community for the audit'],
    ['businesses', 'amy', '/business', 'text=Audit Bakery'],
    ['business back office', 'amy', `/business/${handle}?tab=catalogue`, 'text=Sourdough'],
    ['storefront', 'bob', `/b/${handle}`, 'text=Sourdough'],
    ['orders', 'bob', '/orders', 'main'],
    ['apps', 'amy', '/apps', 'main'],
    ['admin', 'amy', '/admin', '[role=tablist]'],
  ];
  // One sign-in per person (a two-step code can't be used twice), then each screen in both schemes.
  const contexts = {};
  for (const who of [null, 'amy', 'bob']) {
    const ctx = await browser.newContext({ timezoneId: 'UTC' });
    const page = await ctx.newPage();
    page.cspViolations = [];
    page.on('console', (m) => /Content Security Policy/.test(m.text()) && page.cspViolations.push(m.text()));
    if (who) await signIn(page, people[who], who === 'amy');
    contexts[who] = { ctx, page };
  }
  for (const scheme of ['light', 'dark']) {
    for (const [label, who, path, ready] of screens) {
      const { page } = contexts[who];
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${WEB}${path}`);
      await page.waitForSelector(ready, { timeout: 15000 }).catch((e) => {
        throw new Error(`${label}: ${e.message}`);
      });
      if (label === 'chats') await page.click(`text=Bob`);
      await audit(page, `${label} (${scheme})`);
    }
  }
  for (const { ctx, page } of Object.values(contexts)) {
    if (page.cspViolations.length) failures.push(`CSP blocked something the app needs: ${page.cspViolations[0]}`);
    await ctx.close();
  }
  if (failures.length) throw new Error(`accessibility violations:\n  ${failures.join('\n  ')}`);
  step(`axe-core WCAG 2.2 AA: no violations on ${audited.length / 2} screens, in light and dark mode`);

  // Keyboard: a skip link comes first, focus is always visible, and the main menu is reachable.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, bob, false);
  await page.goto(`${WEB}/feed`);
  await page.waitForSelector('text=First post from the accessibility audit');
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => ({ text: document.activeElement?.textContent, href: document.activeElement?.getAttribute('href') }));
  assert(first.href === '#main' && /skip/i.test(first.text ?? ''), `first Tab stop is the skip link, got ${JSON.stringify(first)}`);
  await page.keyboard.press('Enter');
  assert(await page.evaluate(() => document.activeElement?.id === 'main'), 'skip link moves focus to the main content');
  const outlines = [];
  // Tab through the whole screen, until focus leaves the page.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const o = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, text: el.textContent?.slice(0, 30), visible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
    });
    if (!o) break;
    outlines.push(o);
  }
  assert(outlines.length >= 5, `only ${outlines.length} focusable controls on the feed: ${JSON.stringify(outlines)}`);
  assert(outlines.every((o) => o.visible), `every focused control shows a focus ring: ${JSON.stringify(outlines.filter((o) => !o.visible))}`);
  step(`keyboard: skip link first, focus ring on all ${outlines.length} controls of the feed`);

  // CSP: a nonce on each page, and a script injected without it never runs.
  const res = await page.goto(`${WEB}/feed`);
  const csp = res.headers()['content-security-policy'] ?? '';
  assert(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp) && /frame-ancestors 'none'/.test(csp), `CSP header: ${csp}`);
  // What an HTML injection would look like: markup with an inline handler.
  const ran = await page.evaluate(async () => {
    const div = document.createElement('div');
    div.innerHTML = '<img src="/no-such-image.png" onerror="window.__injected = true">';
    document.body.append(div);
    await new Promise((r) => setTimeout(r, 300));
    return !!window.__injected;
  });
  assert(!ran, 'an injected inline handler is refused');
  step('Content Security Policy: nonced scripts only, injected inline handlers refused, no framing');
  await ctx.close();
}

const smtp = await startSmtpSink(SMTP_PORT);
const { StripeSandbox } = createRequire(import.meta.url)(join(apiDir, 'dist/src/dev/stripe-sandbox.js'));
const stripe = new StripeSandbox({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, port: STRIPE_PORT, webhookUrl: `http://127.0.0.1:${API_PORT}/v1/payments/webhooks/stripe` });
await stripe.start();
let browser;
let failed = false;
try {
  await exec('node', ['dist/src/database/migrate.cli.js'], { cwd: apiDir, env });
  // Start each run with empty rate-limit counters, as CI does.
  const Redis = createRequire(join(apiDir, 'package.json'))('ioredis');
  const redis = new Redis(env.REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  const turn = startTurn();
  run('node', ['dist/src/main.js'], { cwd: apiDir, env });
  run('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
    cwd: join(here, '..'),
    env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, API_PUBLIC_WS_URL: `ws://127.0.0.1:${API_PORT}`, CSP_MEDIA_ORIGINS: env.S3_ENDPOINT, NODE_ENV: 'production' },
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/health/ready`);
  await waitFor(`${WEB}/sign-in`);

  // Full Chromium in headless mode: the stripped-down headless shell has no notifications.
  // Fake camera and microphone devices for the calls flow (a test pattern and a beep).
  browser = await chromium.launch({ channel: 'chromium', args: ['--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  const tag = randomBytes(4).toString('hex');
  const email = `e2e_${tag}@example.test`;
  const pw1 = 'first passphrase 123', pw2 = 'second passphrase 456';
  const step = (s) => console.log(`  ✓ ${s}`);

  // E2E_ONLY=calls, business, payments or a11y runs just that flow, for quicker iteration on it.
  all: {
    if (process.env.E2E_ONLY === 'payments') {
      await paymentsFlow(browser, `http://127.0.0.1:${API_PORT}`, tag, step);
      break all;
    }
    if (process.env.E2E_ONLY === 'calls') {
      await callsFlow(browser, `http://127.0.0.1:${API_PORT}`, tag, step, turn);
      break all;
    }
    if (process.env.E2E_ONLY === 'a11y') {
      await a11yFlow(browser, `http://127.0.0.1:${API_PORT}`, tag, step);
      break all;
    }
    if (process.env.E2E_ONLY === 'business') {
      await businessFlow(browser, `http://127.0.0.1:${API_PORT}`, tag, step);
      break all;
    }

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

  // Several requests at once after the access cookie expires share one refresh,
  // instead of tripping the API's stolen-token detection and ending the session.
  await page.context().clearCookies({ name: 'nexa_at' });
  const statuses = await page.evaluate(() => Promise.all([1, 2, 3, 4].map(() => fetch('/api/chat/me/privacy').then((r) => r.status))));
  assert(statuses.every((st) => st === 200), `parallel refresh statuses ${statuses}`);
  await page.goto(`${WEB}/account`);
  assert((await page.textContent('[data-testid=display-name]')) === 'E2E Person', 'still signed in after parallel refresh');
  step('parallel requests with an expired access cookie share one refresh and stay signed in');

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
  await socialFlow(browser, API, tag, step);
  await businessFlow(browser, API, tag, step);
  await paymentsFlow(browser, API, tag, step);
  await a11yFlow(browser, API, tag, step);
  // Last: it stops the TURN relay to test a failed connection.
  await callsFlow(browser, API, tag, step, turn);
  }

  console.log('\nWeb e2e: all checks passed');
} catch (err) {
  failed = true;
  console.error('\nWeb e2e FAILED:', err.message);
} finally {
  await browser?.close();
  smtp.close();
  await stripe.stop();
  for (const p of procs) p.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
}

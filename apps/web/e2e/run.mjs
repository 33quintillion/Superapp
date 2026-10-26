// End-to-end: real API + real Postgres/Redis + production Next build, driven by Chromium.
// Prereqs: Postgres and Redis running, `pnpm --filter @nexa/api build`, `pnpm --filter @nexa/web build`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startSmtpSink } from './smtp-sink.mjs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..', '..', 'api');
const API_PORT = 3100, WEB_PORT = 3101, SMTP_PORT = 2525;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

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

const smtp = await startSmtpSink(SMTP_PORT);
let browser;
let failed = false;
try {
  await exec('node', ['dist/src/database/migrate.cli.js'], { cwd: apiDir, env });
  run('node', ['dist/src/main.js'], { cwd: apiDir, env });
  run('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
    cwd: join(here, '..'),
    env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: 'production' },
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/health/ready`);
  await waitFor(`${WEB}/sign-in`);

  browser = await chromium.launch();
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

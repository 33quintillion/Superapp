import { createHash } from 'node:crypto';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { linkToken, nextIp, req, resetDatabase, startApp, TestContext, uniqueUser } from './helpers';

// A local stand-in for Have I Been Pwned's range API, answering the way the real one does:
// every leaked hash suffix for a 5-character prefix, with zero-count padding mixed in.

const LEAKED = 'summer holiday 2019';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
const asked: string[] = [];
let down = false;
let pwned: Server;
let ctx: TestContext;

beforeAll(async () => {
  await resetDatabase();
  pwned = createServer((r, res) => {
    asked.push(r.url ?? '');
    if (down) {
      res.writeHead(503).end();
      return;
    }
    const prefix = (r.url ?? '').split('/').pop()!;
    const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:3', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0'];
    const h = sha1(LEAKED);
    if (h.startsWith(prefix)) lines.push(`${h.slice(5)}:1042`);
    // Padding that happens to match the password being checked must not count.
    const padded = sha1('a padded entry only');
    if (padded.startsWith(prefix)) lines.push(`${padded.slice(5)}:0`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
  });
  await new Promise<void>((ok) => pwned.listen(0, '127.0.0.1', ok));
  ctx = await startApp({ PASSWORD_BREACH_CHECK: 'hibp', PASSWORD_BREACH_API_URL: `http://127.0.0.1:${(pwned.address() as AddressInfo).port}`, PASSWORD_BREACH_TIMEOUT_MS: '500' });
});

afterAll(async () => {
  await ctx.close();
  await new Promise((ok) => pwned.close(ok));
});

beforeEach(() => {
  asked.length = 0;
  down = false;
});

const register = (password: string) => req(ctx.app, 'POST', '/v1/auth/register', { body: { ...uniqueUser('pw'), password }, ip: nextIp() });

describe('breached passwords', () => {
  it('refuses a leaked password at sign-up, sending only the first 5 characters of its hash', async () => {
    const r = await register(LEAKED);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('password_breached');
    expect(r.body.error.message).toMatch(/data breach/);
    expect(asked).toEqual([`/range/${sha1(LEAKED).slice(0, 5)}`]);
    expect(asked.join()).not.toContain(sha1(LEAKED).slice(5));
  });

  it('accepts passwords that aren’t in a breach, including ones matching only padding', async () => {
    expect((await register('a perfectly fresh phrase 81')).status).toBe(201);
    expect((await register('a padded entry only')).status).toBe(201);
  });

  it('refuses very common passwords without asking the service', async () => {
    const r = await register('Password123');
    expect(r.body.error.code).toBe('password_breached');
    expect(asked).toEqual([]);
  });

  it('lets people sign up when the service is down', async () => {
    down = true;
    expect((await register('outage day passphrase')).status).toBe(201);
    expect(asked).toHaveLength(1);
  });

  it('checks new passwords on reset and change too', async () => {
    const u = { ...uniqueUser('pw'), password: 'original passphrase 7' };
    const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
    expect(reg.status).toBe(201);
    const change = await req(ctx.app, 'POST', '/v1/auth/password/change', { token: reg.body.accessToken, body: { currentPassword: u.password, newPassword: LEAKED } });
    expect(change.body.error.code).toBe('password_breached');

    await req(ctx.app, 'POST', '/v1/auth/password/forgot', { body: { email: u.email } });
    const token = linkToken(ctx.mail.sent.filter((m) => m.to === u.email).pop()!.text);
    const reset = await req(ctx.app, 'POST', '/v1/auth/password/reset', { body: { token, newPassword: LEAKED } });
    expect(reset.body.error.code).toBe('password_breached');
    // The link wasn't used up by the refused attempt.
    expect((await req(ctx.app, 'POST', '/v1/auth/password/reset', { body: { token, newPassword: 'a different new phrase' } })).status).toBe(204);
  });
});

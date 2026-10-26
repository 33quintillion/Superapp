import { Pool } from 'pg';
import { totp } from '../src/crypto/totp';
import { linkToken, nextIp, req, startApp, TEST_ENV, TestContext, uniqueUser } from './helpers';

let ctx: TestContext;
let pool: Pool;
beforeAll(async () => {
  ctx = await startApp();
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
});
afterAll(async () => {
  await ctx.close();
  await pool.end();
});

async function register(u = uniqueUser()) {
  const res = await req(ctx.app, 'POST', '/v1/auth/register', { body: { ...u, deviceName: 'Test phone' }, ip: nextIp() });
  expect(res.status).toBe(201);
  return { u, tokens: res.body as { accessToken: string; refreshToken: string; sessionId: string } };
}

describe('health', () => {
  it('reports live and ready with real dependencies', async () => {
    expect((await req(ctx.app, 'GET', '/health/live')).status).toBe(200);
    const ready = await req(ctx.app, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'ok', redis: 'ok', storage: 'ok' });
  });

  it('returns a structured 404 with a request id', async () => {
    const res = await req(ctx.app, 'GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('registration', () => {
  it('creates an account, a session, and sends a verification email', async () => {
    const { u, tokens } = await register();
    expect(tokens.accessToken).toBeTruthy();
    const me = await req(ctx.app, 'GET', '/v1/me', { token: tokens.accessToken });
    expect(me.body).toMatchObject({ email: u.email, username: u.username, emailVerified: false, mfaEnabled: false });
    const mail = ctx.mail.sent.find((m) => m.to === u.email);
    expect(mail?.subject).toBe('Confirm your email');

    const verified = await req(ctx.app, 'POST', '/v1/auth/verify-email', { body: { token: linkToken(mail!.text) } });
    expect(verified.status).toBe(200);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: tokens.accessToken })).body.emailVerified).toBe(true);
    // Links are single use.
    expect((await req(ctx.app, 'POST', '/v1/auth/verify-email', { body: { token: linkToken(mail!.text) } })).body.error.code).toBe('invalid_token');
  });

  it('normalises email and username case and rejects duplicates', async () => {
    const u = uniqueUser('Dup');
    await register(u);
    const again = await req(ctx.app, 'POST', '/v1/auth/register', { body: { ...u, email: u.email.toUpperCase(), username: 'other_' + u.username.slice(0, 20) } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('email_taken');
    const sameName = await req(ctx.app, 'POST', '/v1/auth/register', { body: { ...uniqueUser(), username: u.username.toUpperCase() } });
    expect(sameName.body.error.code).toBe('username_taken');
  });

  it('validates input', async () => {
    const res = await req(ctx.app, 'POST', '/v1/auth/register', { body: { email: 'not-an-email', password: 'short', username: 'a', displayName: '' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['displayName', 'email', 'password', 'username']);
  });

  it('stores an argon2id hash, never the password', async () => {
    const { u } = await register();
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [u.email]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(u.password);
  });
});

describe('login and sessions', () => {
  it('logs in, and rejects a wrong password with a generic error', async () => {
    const { u } = await register();
    const ok = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    const bad = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: 'wrong password!!' } });
    const nobody = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: 'nobody@example.test', password: 'wrong password!!' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: 'invalid_credentials' });
    expect(nobody.body.error.message).toBe(bad.body.error.message);
  });

  it('rejects missing, malformed and tampered access tokens', async () => {
    const { tokens } = await register();
    expect((await req(ctx.app, 'GET', '/v1/me')).status).toBe(401);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: 'garbage' })).status).toBe(401);
    const [h, p, s] = tokens.accessToken.split('.');
    const tampered = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await req(ctx.app, 'GET', '/v1/me', { token: tampered })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const { tokens } = await register();
    const r1 = await req(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(tokens.refreshToken);
    expect(r1.body.sessionId).toBe(tokens.sessionId);

    // Attacker replays the first token: whole session dies, including the legitimate new token.
    const replay = await req(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    expect(replay.status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: r1.body.accessToken })).status).toBe(401);
    const { rows } = await pool.query('SELECT revoked_reason FROM sessions WHERE id = $1', [tokens.sessionId]);
    expect(rows[0].revoked_reason).toBe('refresh_reuse');
  });

  it('lists devices and revokes one immediately', async () => {
    const { u, tokens: phone } = await register();
    const laptop = (await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password, deviceName: 'Laptop' } })).body;
    const list = await req(ctx.app, 'GET', '/v1/sessions', { token: phone.accessToken });
    expect(list.body.map((s: { deviceName: string }) => s.deviceName).sort()).toEqual(['Laptop', 'Test phone']);
    expect(list.body.find((s: { current: boolean }) => s.current).id).toBe(phone.sessionId);

    expect((await req(ctx.app, 'DELETE', `/v1/sessions/${laptop.sessionId}`, { token: phone.accessToken })).status).toBe(204);
    // Access token is still within its TTL but must no longer work.
    expect((await req(ctx.app, 'GET', '/v1/me', { token: laptop.accessToken })).status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: laptop.refreshToken } })).status).toBe(401);
  });

  it('cannot revoke another user’s session', async () => {
    const a = await register();
    const b = await register();
    expect((await req(ctx.app, 'DELETE', `/v1/sessions/${b.tokens.sessionId}`, { token: a.tokens.accessToken })).status).toBe(404);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: b.tokens.accessToken })).status).toBe(200);
  });

  it('logout ends the current session', async () => {
    const { tokens } = await register();
    expect((await req(ctx.app, 'POST', '/v1/auth/logout', { token: tokens.accessToken })).status).toBe(204);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: tokens.accessToken })).status).toBe(401);
  });
});

describe('password recovery', () => {
  it('resets the password via an emailed link and signs out every device', async () => {
    const { u, tokens } = await register();
    expect((await req(ctx.app, 'POST', '/v1/auth/password/forgot', { body: { email: u.email } })).status).toBe(202);
    const mail = ctx.mail.sent.filter((m) => m.to === u.email && m.subject === 'Reset your password').pop()!;
    const token = linkToken(mail.text);
    const newPassword = 'a brand new passphrase';
    expect((await req(ctx.app, 'POST', '/v1/auth/password/reset', { body: { token, newPassword } })).status).toBe(204);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: tokens.accessToken })).status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: newPassword } })).status).toBe(200);
    expect((await req(ctx.app, 'POST', '/v1/auth/password/reset', { body: { token, newPassword: 'third password here' } })).status).toBe(400);
  });

  it('gives the same answer for unknown emails and sends nothing', async () => {
    const before = ctx.mail.sent.length;
    expect((await req(ctx.app, 'POST', '/v1/auth/password/forgot', { body: { email: 'ghost@example.test' } })).status).toBe(202);
    expect(ctx.mail.sent.length).toBe(before);
  });

  it('rejects expired reset links', async () => {
    const { u } = await register();
    await req(ctx.app, 'POST', '/v1/auth/password/forgot', { body: { email: u.email } });
    const token = linkToken(ctx.mail.sent.filter((m) => m.to === u.email).pop()!.text);
    await pool.query(`UPDATE one_time_tokens SET expires_at = now() - interval '1 second' WHERE purpose = 'reset_password' AND user_id = (SELECT id FROM users WHERE email = $1)`, [u.email]);
    expect((await req(ctx.app, 'POST', '/v1/auth/password/reset', { body: { token, newPassword: 'whatever passphrase' } })).body.error.code).toBe('invalid_token');
  });

  it('change-password keeps this device and signs out others', async () => {
    const { u, tokens } = await register();
    const other = (await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } })).body;
    const res = await req(ctx.app, 'POST', '/v1/auth/password/change', { token: tokens.accessToken, body: { currentPassword: u.password, newPassword: 'changed passphrase ok' } });
    expect(res.status).toBe(204);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: tokens.accessToken })).status).toBe(200);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: other.accessToken })).status).toBe(401);
  });
});

describe('two-step verification (TOTP)', () => {
  it('enrols, requires a code at login, blocks code replay, and can be disabled', async () => {
    const { u, tokens } = await register();
    const setup = await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token: tokens.accessToken });
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const { rows } = await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE email = $1', [u.email]);
    expect(rows[0].mfa_pending_secret_enc).not.toContain(setup.body.secret);

    expect((await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token: tokens.accessToken, body: { code: '000000' } })).status).toBe(400);
    // Enrol with the previous step's code so the current step is still unused for login.
    const prev = totp(setup.body.secret, Date.now() - 30_000);
    expect((await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token: tokens.accessToken, body: { code: prev } })).status).toBe(204);

    const step1 = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } });
    expect(step1.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(step1.body.accessToken).toBeUndefined();

    const code = totp(setup.body.secret);
    const step2 = await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: step1.body.mfaToken, code } });
    expect(step2.status).toBe(200);
    expect(step2.body.accessToken).toBeTruthy();

    // Same code again, fresh challenge: rejected as a replay.
    const again = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } });
    expect((await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: again.body.mfaToken, code } })).status).toBe(400);
    // Challenge tokens are single use.
    expect((await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: step1.body.mfaToken, code } })).status).toBe(400);

    const next = totp(setup.body.secret, Date.now() + 30_000);
    expect((await req(ctx.app, 'POST', '/v1/auth/mfa/disable', { token: tokens.accessToken, body: { password: u.password, code: next } })).status).toBe(204);
    expect((await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } })).body.accessToken).toBeTruthy();
  });
});

describe('rate limiting', () => {
  it('limits login attempts per account and returns Retry-After', async () => {
    const { u } = await register();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: 'wrong password!!' }, ip: `10.0.0.${i}` });
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right password is refused while limited.
    expect((await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password }, ip: '10.0.1.1' })).status).toBe(429);
  });
});

describe('registration rate limit', () => {
  it('limits sign-ups per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await req(ctx.app, 'POST', '/v1/auth/register', { body: uniqueUser('rl'), ip: '203.0.113.9' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

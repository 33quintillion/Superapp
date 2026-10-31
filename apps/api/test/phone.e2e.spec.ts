import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { Pool } from 'pg';
import { totp } from '../src/crypto/totp';
import { linkToken, nextIp, req, startApp, TEST_ENV, TestContext } from './helpers';

/**
 * Phone sign-in. Firebase texts the code and hands the app a signed ID token; these tests
 * stand in for Google's key server and sign the tokens themselves, so everything the API
 * checks (signature, project, provider, freshness, country, one use) is exercised.
 */
const PROJECT = 'nexa-phone-test';
let ctx: TestContext;
let pool: Pool;
let jwks: Server;
let key: KeyLike;
let otherKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const served: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [served] }));
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  ctx = await startApp({
    EMAIL_SIGNUP: 'false',
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/keys`,
    PHONE_COUNTRY_CODES: '+91',
  });
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
});
afterAll(async () => {
  await ctx.close();
  await pool.end();
  await new Promise<void>((r) => jwks.close(() => r()));
});

let numbers = 0;
/** A fresh Indian mobile number for each test. */
function newNumber() {
  numbers += 1;
  return `+919${String(process.pid % 10000).padStart(4, '0')}${String(numbers).padStart(5, '0')}`;
}

/** What Firebase would hand the app after the code is typed in. */
async function idToken(phone: string, o: { aud?: string; iss?: string; provider?: string; authAgo?: number; signer?: KeyLike; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    phone_number: phone,
    auth_time: now - (o.authAgo ?? 5),
    firebase: { sign_in_provider: o.provider ?? 'phone', identities: { phone: [phone] } },
  })
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1' })
    .setIssuer(o.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(o.aud ?? PROJECT)
    .setSubject(`firebase-uid-${phone.slice(1)}`)
    // Real tokens differ by issue time; two made here within a second would otherwise be identical.
    .setJti(randomUUID())
    .setIssuedAt(now - 5)
    .setExpirationTime(now + 3600)
    .sign(o.signer ?? key);
}

const call = (method: string, url: string, opts: { body?: unknown; token?: string } = {}) => req(ctx.app, method, url, { ...opts, ip: nextIp() });

/** Signs up a new number all the way through and returns its tokens. */
async function signUp(phone = newNumber(), displayName = 'Asha', username?: string) {
  const first = await call('POST', '/v1/auth/phone', { body: { idToken: await idToken(phone), deviceName: 'Pixel' } });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ signupRequired: true, phone });
  const done = await call('POST', '/v1/auth/phone/complete', { body: { signupToken: first.body.signupToken, displayName, username, deviceName: 'Pixel' } });
  expect(done.status).toBe(201);
  return { phone, token: done.body.accessToken as string };
}

describe('phone sign-up and sign-in', () => {
  it('creates an account from a verified number, then signs the same number back in', async () => {
    const { phone, token } = await signUp();
    const me = (await call('GET', '/v1/me', { token })).body;
    expect(me).toMatchObject({ phone, email: null, emailVerified: false, username: null, displayName: 'Asha' });
    const row = (await pool.query('SELECT phone_verified_at, password_hash FROM users WHERE id = $1', [me.id])).rows[0];
    expect(row.phone_verified_at).not.toBeNull();
    expect(row.password_hash).toBeNull();

    const again = await call('POST', '/v1/auth/phone', { body: { idToken: await idToken(phone) } });
    expect(again.status).toBe(200);
    expect(again.body.accessToken).toBeTruthy();
    expect(again.body.signupRequired).toBeUndefined();
    expect((await call('GET', '/v1/me', { token: again.body.accessToken })).body.id).toBe(me.id);
  });

  it('accepts each ID token once', async () => {
    const phone = newNumber();
    const t = await idToken(phone);
    expect((await call('POST', '/v1/auth/phone', { body: { idToken: t } })).status).toBe(200);
    const replay = await call('POST', '/v1/auth/phone', { body: { idToken: t } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('invalid_token');
  });

  it('refuses tokens for another project, from another signer, from another sign-in method, or with an old code', async () => {
    const phone = newNumber();
    const cases: [Promise<string>, number, string][] = [
      [idToken(phone, { aud: 'someone-else' }), 400, 'invalid_token'],
      [idToken(phone, { iss: 'https://securetoken.google.com/someone-else' }), 400, 'invalid_token'],
      [idToken(phone, { signer: otherKey }), 400, 'invalid_token'],
      [idToken(phone, { provider: 'password' }), 400, 'invalid_token'],
      [idToken(phone, { authAgo: 3600 }), 401, 'phone_code_expired'],
    ];
    for (const [t, status, code] of cases) {
      const r = await call('POST', '/v1/auth/phone', { body: { idToken: await t } });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
    }
    expect((await call('POST', '/v1/auth/phone', { body: { idToken: 'not.a.token' } })).status).toBe(400);
    expect((await pool.query('SELECT 1 FROM users WHERE phone_e164 = $1', [phone])).rowCount).toBe(0);
  });

  it('is open to Indian numbers only for now', async () => {
    const r = await call('POST', '/v1/auth/phone', { body: { idToken: await idToken('+14165550123') } });
    expect([r.status, r.body.error.code]).toEqual([400, 'phone_country_not_supported']);
  });

  it('needs a name, takes an optional username, and keeps the sign-up token until it works', async () => {
    await signUp(newNumber(), 'Meera', `taken_${process.pid % 10000}`);
    const phone = newNumber();
    const signupToken = (await call('POST', '/v1/auth/phone', { body: { idToken: await idToken(phone) } })).body.signupToken;
    expect((await call('POST', '/v1/auth/phone/complete', { body: { signupToken, displayName: '' } })).status).toBe(400);
    const clash = await call('POST', '/v1/auth/phone/complete', { body: { signupToken, displayName: 'Ravi', username: `taken_${process.pid % 10000}` } });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'username_taken']);
    const ok = await call('POST', '/v1/auth/phone/complete', { body: { signupToken, displayName: 'Ravi', username: `ravi_${process.pid % 10000}` } });
    expect(ok.status).toBe(201);
    // Spent once the account exists.
    expect((await call('POST', '/v1/auth/phone/complete', { body: { signupToken, displayName: 'Ravi' } })).body.error.code).toBe('invalid_token');
    expect((await call('POST', '/v1/auth/phone/complete', { body: { signupToken: 'x'.repeat(43), displayName: 'Nobody' } })).body.error.code).toBe('invalid_token');
  });

  it('asks for the two-step code when the account has it on', async () => {
    const { phone, token } = await signUp();
    const { secret, otpauthUri } = (await call('POST', '/v1/auth/mfa/setup', { token })).body;
    expect(decodeURIComponent(otpauthUri)).toContain(phone);
    expect((await call('POST', '/v1/auth/mfa/confirm', { token, body: { code: totp(secret, Date.now() - 30_000) } })).status).toBe(204);
    const r = await call('POST', '/v1/auth/phone', { body: { idToken: await idToken(phone) } });
    expect(r.body.mfaRequired).toBe(true);
    const done = await call('POST', '/v1/auth/login/mfa', { body: { mfaToken: r.body.mfaToken, code: totp(secret) } });
    expect(done.status).toBe(200);

    // Turning it off without a password: a fresh code to the same number, plus the two-step code.
    const off = await call('POST', '/v1/auth/mfa/disable', { token, body: { code: totp(secret, Date.now() + 30_000) } });
    expect(off.body.error.code).toBe('phone_confirmation_required');
    const ok = await call('POST', '/v1/auth/mfa/disable', { token, body: { phoneIdToken: await idToken(phone), code: totp(secret, Date.now() + 30_000) } });
    expect(ok.status).toBe(204);
  });

  it('closes email sign-up', async () => {
    const r = await call('POST', '/v1/auth/register', { body: { email: 'new@example.test', password: 'a long enough passphrase', username: 'emailer', displayName: 'E' } });
    expect([r.status, r.body.error.code]).toEqual([403, 'email_signup_closed']);
  });
});

describe('optional email', () => {
  it('adds, confirms, changes and removes an email on a phone account', async () => {
    const { token } = await signUp();
    const email = `asha${process.pid % 10000}_${numbers}@example.test`;
    const set = await call('PUT', '/v1/me/email', { token, body: { email } });
    expect(set.body).toEqual({ email, verified: false });
    const link = ctx.mail.sent.filter((m) => m.to === email).at(-1)!;
    expect(link.subject).toBe('Confirm your email');
    expect((await call('POST', '/v1/auth/verify-email', { body: { token: linkToken(link.text) } })).status).toBe(200);
    expect((await call('GET', '/v1/me', { token })).body).toMatchObject({ email, emailVerified: true });

    // A new address starts unconfirmed, and links sent to the old one stop working.
    const other = `asha_new${process.pid % 10000}_${numbers}@example.test`;
    await call('PUT', '/v1/me/email', { token, body: { email: other } });
    await call('PUT', '/v1/me/email', { token, body: { email } });
    const stale = ctx.mail.sent.filter((m) => m.to === other).at(-1)!;
    expect((await call('POST', '/v1/auth/verify-email', { body: { token: linkToken(stale.text) } })).status).toBe(400);
    expect((await call('GET', '/v1/me', { token })).body).toMatchObject({ email, emailVerified: false });

    expect((await call('DELETE', '/v1/me/email', { token })).status).toBe(204);
    expect((await call('GET', '/v1/me', { token })).body).toMatchObject({ email: null, emailVerified: false });
  });

  it('keeps one email per account', async () => {
    const a = await signUp();
    const b = await signUp();
    const email = `shared${process.pid % 10000}_${numbers}@example.test`;
    await call('PUT', '/v1/me/email', { token: a.token, body: { email } });
    const r = await call('PUT', '/v1/me/email', { token: b.token, body: { email } });
    expect([r.status, r.body.error.code]).toEqual([409, 'email_taken']);
  });
});

describe('closing a phone account', () => {
  it('needs a fresh code sent to the account\'s own number', async () => {
    const { phone, token } = await signUp();
    expect((await call('DELETE', '/v1/me', { token, body: {} })).body.error.code).toBe('phone_confirmation_required');
    expect((await call('DELETE', '/v1/me', { token, body: { phoneIdToken: await idToken(newNumber()) } })).status).toBe(400);
    expect((await call('DELETE', '/v1/me', { token, body: { phoneIdToken: await idToken(phone, { authAgo: 3600 }) } })).body.error.code).toBe('phone_code_expired');
    expect((await call('DELETE', '/v1/me', { token, body: { phoneIdToken: await idToken(phone) } })).status).toBe(204);
    // The number is free again for a new account.
    expect((await call('POST', '/v1/auth/phone', { body: { idToken: await idToken(phone) } })).body.signupRequired).toBe(true);
  });
});

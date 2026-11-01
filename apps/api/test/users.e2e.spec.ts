import { Pool } from 'pg';
import { nextIp, req, startApp, TEST_ENV, TestContext, uniqueUser } from './helpers';

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

async function register() {
  const u = uniqueUser('p');
  const res = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
  expect(res.status).toBe(201);
  const me = await req(ctx.app, 'GET', '/v1/me', { token: res.body.accessToken });
  return { u, token: res.body.accessToken as string, id: me.body.id as string };
}

describe('profile and privacy', () => {
  it('updates profile fields and rejects unknown ones', async () => {
    const a = await register();
    const res = await req(ctx.app, 'PATCH', '/v1/me', { token: a.token, body: { displayName: 'Ada', bio: 'Hello', statusText: 'Busy', locale: 'pt-BR' } });
    expect(res.body).toMatchObject({ displayName: 'Ada', bio: 'Hello', statusText: 'Busy', locale: 'pt-BR' });
    expect((await req(ctx.app, 'PATCH', '/v1/me', { token: a.token, body: { email: 'x@y.z' } })).status).toBe(400);
  });

  it('defaults to private contact discovery and lets the user change it', async () => {
    const a = await register();
    const p = await req(ctx.app, 'GET', '/v1/me/privacy', { token: a.token });
    expect(p.body).toMatchObject({ discoverableByEmail: false, discoverableByPhone: false, discoverableByUsername: true });
    const upd = await req(ctx.app, 'PATCH', '/v1/me/privacy', { token: a.token, body: { discoverableByUsername: false, whoCanMessage: 'contacts' } });
    expect(upd.body).toMatchObject({ discoverableByUsername: false, whoCanMessage: 'contacts' });
  });

  it('hides a profile from username lookup when the owner opts out', async () => {
    const a = await register();
    const b = await register();
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: b.token })).status).toBe(200);
    await req(ctx.app, 'PATCH', '/v1/me/privacy', { token: a.token, body: { discoverableByUsername: false } });
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: b.token })).status).toBe(404);
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: a.token })).status).toBe(200);
  });
});

describe('finding people you know', () => {
  const match = (token: string, body: unknown) => req(ctx.app, 'POST', '/v1/contacts/match', { token, body });
  let n = 0;
  /** A person with a confirmed email and phone number, findable by them or not. */
  async function person(findable: { email?: boolean; phone?: boolean }) {
    const p = await register();
    n += 1;
    const phone = `+4479${String(process.pid).slice(-4).padStart(4, '0')}${String(n).padStart(4, '0')}`;
    await pool.query('UPDATE users SET email_verified_at = now(), phone_e164 = $2, phone_verified_at = now() WHERE id = $1', [p.id, phone]);
    await req(ctx.app, 'PATCH', '/v1/me/privacy', { token: p.token, body: { discoverableByEmail: !!findable.email, discoverableByPhone: !!findable.phone } });
    return { ...p, email: p.u.email.toLowerCase(), phone };
  }

  it('finds only people who chose to be found that way', async () => {
    const me = await register();
    const byEmail = await person({ email: true });
    const byPhone = await person({ phone: true });
    const hidden = await person({});
    const r = await match(me.token, {
      emails: [byEmail.email.toUpperCase(), byPhone.email, hidden.email, 'not an email'],
      // Written the way address books do.
      phones: [byPhone.phone.replace(/^(\+44)(\d{4})/, '$1 ($2) '), byEmail.phone, hidden.phone, '0800 123'],
    });
    expect(r.status).toBe(200);
    expect(r.body.matches).toHaveLength(2);
    expect(r.body.matches).toEqual(
      expect.arrayContaining([
        { matched: byEmail.email, user: { id: byEmail.id, username: byEmail.u.username, displayName: expect.any(String), avatarMediaId: null } },
        { matched: byPhone.phone, user: expect.objectContaining({ id: byPhone.id }) },
      ]),
    );
    // Nothing else about them, and never the other way of reaching them.
    expect(JSON.stringify(r.body)).not.toContain(byEmail.phone);
    expect(JSON.stringify(r.body)).not.toContain(byPhone.email);
  });

  it('skips unconfirmed addresses, blocked people, and yourself', async () => {
    const me = await person({ email: true });
    const unconfirmed = await person({ email: true });
    await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [unconfirmed.id]);
    const blocker = await person({ email: true });
    await req(ctx.app, 'POST', '/v1/blocks', { token: blocker.token, body: { userId: me.id } });
    const r = await match(me.token, { emails: [me.email, unconfirmed.email, blocker.email] });
    expect(r.body.matches).toEqual([]);
  });

  it('limits the size and number of lookups', async () => {
    const me = await register();
    const many = Array.from({ length: 1001 }, (_, i) => `x${i}@example.test`);
    expect((await match(me.token, { emails: many })).status).toBe(400);
    expect((await match(me.token, { emails: many.slice(0, 600), phones: Array(401).fill('+447900000000') })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await match(me.token, { emails: [] })).status).toBe(200);
    expect((await match(me.token, { emails: [] })).status).toBe(429);
  });
});

describe('blocking and reporting', () => {
  it('a block hides both users from each other and can be undone', async () => {
    const a = await register();
    const b = await register();
    expect((await req(ctx.app, 'POST', '/v1/blocks', { token: a.token, body: { userId: b.id } })).status).toBe(204);
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: b.token })).status).toBe(404);
    expect((await req(ctx.app, 'GET', `/v1/users/${b.u.username}`, { token: a.token })).status).toBe(404);
    expect((await req(ctx.app, 'GET', '/v1/blocks', { token: a.token })).body.map((x: { userId: string }) => x.userId)).toEqual([b.id]);
    expect((await req(ctx.app, 'DELETE', `/v1/blocks/${b.id}`, { token: a.token })).status).toBe(204);
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: b.token })).status).toBe(200);
  });

  it('refuses self-blocks and unknown users', async () => {
    const a = await register();
    expect((await req(ctx.app, 'POST', '/v1/blocks', { token: a.token, body: { userId: a.id } })).status).toBe(400);
    expect((await req(ctx.app, 'POST', '/v1/blocks', { token: a.token, body: { userId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
  });

  it('files a report and records it as open', async () => {
    const a = await register();
    const b = await register();
    const r = await req(ctx.app, 'POST', '/v1/reports', { token: a.token, body: { subjectType: 'user', subjectId: b.id, reason: 'spam', details: 'Sends links' } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('open');
    expect((await req(ctx.app, 'POST', '/v1/reports', { token: a.token, body: { subjectType: 'user', subjectId: b.id, reason: 'not-a-reason' } })).status).toBe(400);
  });
});

describe('account lifecycle', () => {
  it('exports the user’s data without secrets', async () => {
    const a = await register();
    const res = await req(ctx.app, 'GET', '/v1/me/export', { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBe(a.u.email);
    expect(res.body.sessions.length).toBe(1);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/password_hash|refresh_token_hash|argon2/);
  });

  it('deactivation signs out everywhere and logging in again reactivates', async () => {
    const a = await register();
    expect((await req(ctx.app, 'POST', '/v1/me/deactivate', { token: a.token, body: { password: 'wrong one' } })).status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/me/deactivate', { token: a.token, body: { password: a.u.password } })).status).toBe(204);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: a.token })).status).toBe(401);
    const b = await register();
    expect((await req(ctx.app, 'GET', `/v1/users/${a.u.username}`, { token: b.token })).status).toBe(404);
    const login = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: a.u.email, password: a.u.password } });
    expect(login.status).toBe(200);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: login.body.accessToken })).status).toBe(200);
  });

  it('deletion scrubs personal data, frees the email and username, and blocks login', async () => {
    const a = await register();
    const b = await register();
    await req(ctx.app, 'POST', '/v1/blocks', { token: b.token, body: { userId: a.id } });
    await req(ctx.app, 'POST', '/v1/reports', { token: a.token, body: { subjectType: 'user', subjectId: b.id, reason: 'spam' } });

    expect((await req(ctx.app, 'DELETE', '/v1/me', { token: a.token, body: { password: a.u.password } })).status).toBe(204);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: a.token })).status).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: a.u.email, password: a.u.password } })).status).toBe(401);

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [a.id]);
    expect(rows[0]).toMatchObject({ state: 'deleted', email: null, username: null, password_hash: null, display_name: '', bio: '' });
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [a.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM blocks WHERE blocked_id = $1', [a.id])).rows[0].n).toBe(0);
    // Report survives for moderation, detached from the deleted reporter.
    expect((await pool.query('SELECT reporter_id FROM reports WHERE subject_id = $1', [b.id])).rows[0].reporter_id).toBeNull();

    const reuse = await req(ctx.app, 'POST', '/v1/auth/register', { body: { ...a.u }, ip: nextIp() });
    expect(reuse.status).toBe(201);
  });
});

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

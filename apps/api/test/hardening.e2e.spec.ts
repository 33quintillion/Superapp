import { Pool } from 'pg';
import { totp } from '../src/crypto/totp';
import { clientId, nextIp, registerUser, req, startApp, TEST_ENV, TestContext, uniqueUser } from './helpers';

// Stage 9 security review fixes (docs/hardening.md). A load balancer at 10.20.0.1 sits in front of the API, as in staging.
let ctx: TestContext;
let pool: Pool;
beforeAll(async () => {
  ctx = await startApp({ TRUST_PROXY: '10.20.0.0/16' });
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
});
afterAll(async () => {
  await ctx.close();
  await pool.end();
});

const forwarded = (xff: string) => ({ 'x-forwarded-for': xff });

describe('client addresses behind a proxy', () => {
  it('takes the address the proxy saw, so a forged X-Forwarded-For entry cannot dodge per-IP limits', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // A new made-up address every time, then the real one the proxy appended.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: uniqueUser('xff'),
        remoteAddress: '10.20.0.1',
        headers: forwarded(`198.18.${i}.${i + 1}, 203.0.113.50`),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Someone else behind the same proxy is not affected.
    const other = await ctx.app.inject({ method: 'POST', url: '/v1/auth/register', payload: uniqueUser('xff'), remoteAddress: '10.20.0.1', headers: forwarded('203.0.113.51') });
    expect(other.statusCode).toBe(201);
  });
});

describe('re-entering the password in a signed-in session', () => {
  it('is rate limited, so a stolen session cannot be used to guess the password', async () => {
    const u = await registerUser(ctx.app, 'pw');
    for (let i = 0; i < 10; i++) {
      const r = await req(ctx.app, 'POST', '/v1/auth/password/change', { token: u.token, body: { currentPassword: `wrong guess ${i}!!`, newPassword: 'a new passphrase 42' } });
      expect(r.status).toBe(401);
    }
    // Every endpoint that asks for the password shares the budget, and even the right password waits.
    expect((await req(ctx.app, 'DELETE', '/v1/me', { token: u.token, body: { password: u.password } })).status).toBe(429);
    expect((await req(ctx.app, 'POST', '/v1/me/deactivate', { token: u.token, body: { password: u.password } })).status).toBe(429);
    expect((await req(ctx.app, 'GET', '/v1/me', { token: u.token })).status).toBe(200);
  });
});

describe('two-step codes', () => {
  it('are limited per account, not just per challenge, so new challenges do not buy more guesses', async () => {
    const u = await registerUser(ctx.app, 'totp');
    const setup = await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token: u.token });
    const confirm = await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token: u.token, body: { code: totp(setup.body.secret, Date.now() - 30_000) } });
    expect(confirm.status).toBe(204);
    const me = await req(ctx.app, 'GET', '/v1/me', { token: u.token });
    const challenge = async () => {
      const r = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: me.body.email, password: u.password }, ip: nextIp() });
      expect(r.body.mfaRequired).toBe(true);
      return r.body.mfaToken as string;
    };
    let guesses = 0;
    // Each challenge allows 5 tries; three challenges would allow 15 without the account limit.
    for (let c = 0; c < 3 && guesses < 10; c++) {
      const mfaToken = await challenge();
      for (let i = 0; i < 4 && guesses < 10; i++, guesses++) {
        const wrong = String((Number(totp(setup.body.secret)) + 500_000 + guesses) % 1_000_000).padStart(6, '0');
        expect((await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken, code: wrong }, ip: nextIp() })).status).toBe(400);
      }
    }
    const fresh = await challenge();
    const right = await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: fresh, code: totp(setup.body.secret) }, ip: nextIp() });
    expect(right.status).toBe(429);
  });
});

describe('account export', () => {
  it('is limited to a few a hour', async () => {
    const u = await registerUser(ctx.app, 'exp');
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await req(ctx.app, 'GET', '/v1/me/export', { token: u.token })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('feed (rewritten to read each source by index)', () => {
  it('fills every page even when the newest posts are hidden, merges sources in order, and lists each post once', async () => {
    const [me, friend, stranger] = [await registerUser(ctx.app, 'fdm'), await registerUser(ctx.app, 'fdf'), await registerUser(ctx.app, 'fds')];
    expect((await req(ctx.app, 'POST', `/v1/users/${friend.id}/follow`, { token: me.token })).status).toBe(200);
    // The friend's 30 newest posts are only for them; 25 older ones are public.
    await pool.query(
      `INSERT INTO posts (author_id, client_id, audience, body, created_at)
       SELECT $1, 'hardening' || i, CASE WHEN i <= 30 THEN 'only_me' ELSE 'public' END, 'friend ' || i, date_trunc('milliseconds', now() - i * interval '1 minute')
         FROM generate_series(1, 55) i`,
      [friend.id],
    );
    // Someone I don't follow posts constantly; none of it is mine to see in the feed.
    await pool.query(
      `INSERT INTO posts (author_id, client_id, audience, body, created_at)
       SELECT $1, 'hardstranger' || i, 'public', 'stranger', date_trunc('milliseconds', now() - i * interval '10 seconds') FROM generate_series(1, 200) i`,
      [stranger.id],
    );
    // My own post in a community I belong to is reachable two ways but shows once.
    const c = await req(ctx.app, 'POST', '/v1/communities', { token: me.token, body: { slug: `hd${me.username.slice(-8)}`, name: 'Hardening' } });
    expect(c.status).toBe(201);
    const mine = await req(ctx.app, 'POST', '/v1/posts', { token: me.token, body: { clientId: clientId(), body: 'in my community', communityId: c.body.id } });
    expect(mine.status).toBe(201);

    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page: { body: { posts: { id: string; body: string; createdAt: string }[]; nextCursor: string | null } } = await req(ctx.app, 'GET', `/v1/feed?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token: me.token });
      sizes.push(page.body.posts.length);
      seen.push(...page.body.posts.map((p) => p.body));
      const times = page.body.posts.map((p) => Date.parse(p.createdAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['in my community', ...Array.from({ length: 25 }, (_, i) => `friend ${i + 31}`)]);
    expect(sizes).toEqual([10, 10, 6]);
  });
});

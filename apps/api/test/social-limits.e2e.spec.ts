import { randomUUID } from 'node:crypto';
import { RedisService } from '../src/redis/redis.service';
import { registerUser, req, resetDatabase, startApp, TestContext, TestUser } from './helpers';

// Each per-person limit on social actions is wired to the right action with the right size.
// Rather than make hundreds of requests, the counter is set to the limit; the next action is
// refused, the same action by someone else isn't, and one under the limit goes through.

let ctx: TestContext;
beforeAll(async () => {
  await resetDatabase();
  ctx = await startApp();
});
afterAll(() => ctx.close());

const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

/** Sets how many times [user] has done [name] in the current window. */
async function setCount(name: string, windowSeconds: number, user: TestUser, count: number) {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  await ctx.app.get(RedisService).client.set(`rl:${name}:${user.id}:${window}`, String(count), 'EX', windowSeconds);
}

interface Case {
  name: string;
  limit: number;
  windowSeconds: number;
  /** Does the action once; resolves with the status. */
  act: (u: TestUser) => Promise<number>;
}

let target: TestUser;
let postId: string;
let communityIds: string[] = [];

beforeAll(async () => {
  target = await registerUser(ctx.app, 'lim_t');
  const p = await call('POST', '/v1/posts', target, { clientId: randomUUID(), body: 'something to like', audience: 'public' });
  postId = p.body.post.id;
  for (let i = 0; i < 3; i++) {
    const c = await call('POST', '/v1/communities', target, { slug: `lim-${process.pid}-${i}`, name: `Limits ${i}` });
    communityIds.push(c.body.id);
  }
});

let n = 0;
const cases: Case[] = [
  { name: 'post:create', limit: 30, windowSeconds: 3600, act: async (u) => (await call('POST', '/v1/posts', u, { clientId: randomUUID(), body: 'hi' })).status },
  // Only liking counts; taking a like back is always allowed.
  { name: 'post:like', limit: 600, windowSeconds: 3600, act: async (u) => (await call('PUT', `/v1/posts/${postId}/like`, u, { liked: true })).status },
  { name: 'post:comment', limit: 120, windowSeconds: 3600, act: async (u) => (await call('POST', `/v1/posts/${postId}/comments`, u, { body: 'nice' })).status },
  { name: 'story:create', limit: 50, windowSeconds: 86400, act: async (u) => (await call('POST', '/v1/stories', u, { kind: 'text', body: 'today' })).status },
  { name: 'follow', limit: 200, windowSeconds: 86400, act: async (u) => (await call('POST', `/v1/users/${target.id}/follow`, u)).status },
  {
    name: 'community:create',
    limit: 5,
    windowSeconds: 86400,
    act: async (u) => (await call('POST', '/v1/communities', u, { slug: `c${(n += 1)}-${process.pid}-${u.username.slice(-6)}`.slice(0, 40), name: 'A place' })).status,
  },
  { name: 'community:join', limit: 100, windowSeconds: 86400, act: async (u) => (await call('POST', `/v1/communities/${communityIds[(n += 1) % 3]}/join`, u)).status },
  { name: 'group:create', limit: 20, windowSeconds: 3600, act: async (u) => (await call('POST', '/v1/conversations/groups', u, { title: 'Book club', memberIds: [] })).status },
];

describe('per-person limits on social actions', () => {
  it.each(cases)('$name: $limit per window, per person', async (c) => {
    const busy = await registerUser(ctx.app, 'lim_b');
    const other = await registerUser(ctx.app, 'lim_o');
    await setCount(c.name, c.windowSeconds, busy, c.limit - 1);
    expect(await c.act(busy)).toBeLessThan(300); // the last one allowed
    const refused = await c.act(busy);
    expect(refused).toBe(429);
    // Someone else isn't affected.
    expect(await c.act(other)).toBeLessThan(300);
  });

  it('says when to try again', async () => {
    const u = await registerUser(ctx.app, 'lim_r');
    await setCount('post:create', 3600, u, 30);
    const r = await call('POST', '/v1/posts', u, { clientId: randomUUID(), body: 'one more' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    const retry = Number(r.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
  });
});

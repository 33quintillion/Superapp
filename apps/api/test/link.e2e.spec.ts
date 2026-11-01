import { describeAgent } from '../src/auth/link.service';
import { RedisService } from '../src/redis/redis.service';
import { nextIp, registerUser, req, startApp, TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => {
  await ctx.close();
});

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/** What the computer does: ask for a code. */
async function startLink(deviceName = 'Web browser') {
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/link', payload: { deviceName }, headers: { 'user-agent': CHROME_WINDOWS }, remoteAddress: nextIp() });
  expect(res.statusCode).toBe(201);
  return res.json() as { code: string; secret: string; expiresIn: number };
}

const collect = (code: string, secret: string) => req(ctx.app, 'POST', '/v1/auth/link/collect', { body: { code, secret }, ip: nextIp() });

describe('linking a computer from a signed-in phone', () => {
  it('shows what is being linked, links it once, and the computer gets its own session', async () => {
    const phone = await registerUser(ctx.app, 'link');
    const link = await startLink();
    expect(link.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(link.expiresIn).toBe(120);

    expect((await collect(link.code, link.secret)).body).toMatchObject({ status: 'pending' });

    // The phone may read the code with a dash or in lower case.
    const typed = `${link.code.slice(0, 4)}-${link.code.slice(4)}`.toLowerCase();
    const seen = await req(ctx.app, 'GET', `/v1/auth/link/${typed}`, { token: phone.token });
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ deviceName: 'Web browser', browser: 'Chrome on Windows' });
    expect((await req(ctx.app, 'POST', `/v1/auth/link/${typed}/approve`, { token: phone.token })).status).toBe(204);

    const got = await collect(link.code, link.secret);
    expect(got.status).toBe(200);
    expect(got.body.accessToken).toBeTruthy();
    const me = await req(ctx.app, 'GET', '/v1/me', { token: got.body.accessToken });
    expect(me.body.id).toBe(phone.id);
    const sessions = (await req(ctx.app, 'GET', '/v1/sessions', { token: phone.token })).body as { deviceName: string }[];
    expect(sessions.map((s) => s.deviceName)).toContain('Web browser');

    // Used up: neither the computer nor anyone else can collect it again, or approve it again.
    expect((await collect(link.code, link.secret)).body.error.code).toBe('invalid_token');
    expect((await req(ctx.app, 'POST', `/v1/auth/link/${link.code}/approve`, { token: phone.token })).body.error.code).toBe('invalid_token');
  });

  it('gives the session only to the computer that holds the secret', async () => {
    const phone = await registerUser(ctx.app, 'link');
    const link = await startLink();
    await req(ctx.app, 'POST', `/v1/auth/link/${link.code}/approve`, { token: phone.token });
    expect((await collect(link.code, 'x'.repeat(43))).body.error.code).toBe('invalid_token');
    // The real computer still gets it afterwards.
    expect((await collect(link.code, link.secret)).body.accessToken).toBeTruthy();
  });

  it('needs a signed-in phone to look at or approve a code', async () => {
    const link = await startLink();
    expect((await req(ctx.app, 'GET', `/v1/auth/link/${link.code}`)).status).toBe(401);
    expect((await req(ctx.app, 'POST', `/v1/auth/link/${link.code}/approve`)).status).toBe(401);
    expect((await collect(link.code, link.secret)).body).toMatchObject({ status: 'pending' });
  });

  it('refuses unknown and expired codes', async () => {
    const phone = await registerUser(ctx.app, 'link');
    expect((await req(ctx.app, 'GET', '/v1/auth/link/ZZZZZZZZ', { token: phone.token })).body.error.code).toBe('invalid_token');
    const link = await startLink();
    await ctx.app.get(RedisService).client.del(`link:${link.code}`);
    expect((await req(ctx.app, 'POST', `/v1/auth/link/${link.code}/approve`, { token: phone.token })).body.error.code).toBe('invalid_token');
    expect((await collect(link.code, link.secret)).body.error.code).toBe('invalid_token');
  });
});

describe('describing the linking device', () => {
  it('names common browsers and systems', () => {
    expect(describeAgent(CHROME_WINDOWS)).toBe('Chrome on Windows');
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari on Mac');
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on Windows');
    expect(describeAgent(null)).toBeNull();
  });
});

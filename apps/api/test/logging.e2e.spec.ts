import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/app';
import { nextIp, resetDatabase, testConfig, uniqueUser } from './helpers';

// The real logger, at its most verbose, writing to memory: secrets must never show up in it.

let app: NestFastifyApplication;
let lines: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      done();
    },
  });
  app = await createApp(testConfig({ LOG_LEVEL: 'trace' }), { logStream: stream });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(() => app.close());
beforeEach(() => (lines = []));

const inject = (method: string, url: string, body?: object, token?: string) =>
  app.inject({ method: method as 'POST', url, payload: body, remoteAddress: nextIp(), headers: token ? { authorization: `Bearer ${token}`, cookie: 'session=cookie-secret-value' } : {} });

describe('logs', () => {
  it('never contain passwords, tokens, the authorization header or cookies, while requests are still logged', async () => {
    const u = uniqueUser('log');
    const reg = await inject('POST', '/v1/auth/register', u);
    expect(reg.statusCode).toBe(201);
    const { accessToken, refreshToken } = reg.json();
    await inject('POST', '/v1/auth/login', { email: u.email, password: u.password });
    await inject('POST', '/v1/auth/login', { email: u.email, password: 'a wrong password entirely' });
    await inject('POST', '/v1/auth/refresh', { refreshToken });
    await inject('GET', '/v1/me', undefined, accessToken);

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(all).toContain('/v1/auth/login');
    for (const secret of [u.password, 'a wrong password entirely', accessToken, refreshToken, 'cookie-secret-value']) {
      expect(all).not.toContain(secret);
    }
  });

  it('redacts secrets even when code logs a whole request or body', async () => {
    const log = app.getHttpAdapter().getInstance().log;
    log.info(
      {
        req: { headers: { authorization: 'Bearer leaked-access-token', cookie: 'sid=leaked-cookie' } },
        body: { password: 'leaked-password', refreshToken: 'leaked-refresh', token: 'leaked-link-token', accessToken: 'leaked-access' },
      },
      'something went wrong',
    );
    const line = lines.find((l) => l.includes('something went wrong'))!;
    expect(line).toBeDefined();
    expect(line).not.toMatch(/leaked/);
    expect(JSON.parse(line).body.password).toBe('[Redacted]');
  });
});

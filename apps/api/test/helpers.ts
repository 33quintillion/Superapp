import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createApp } from '../src/app';
import { AppConfig, loadConfig } from '../src/config/config';
import { migrate } from '../src/database/migrator';
import { MailService } from '../src/mail/mail.service';

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://superapp:superapp_dev@localhost:5432/superapp_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
  JWT_ACCESS_SECRET: 'test-only-secret-test-only-secret-0123456789',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAIL_TRANSPORT: 'memory',
  LOG_LEVEL: 'error',
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  S3_BUCKET: 'nexa-test',
  S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_AUTO_CREATE_BUCKET: 'true',
  // Push tests drive the worker by hand; the rest don't need it polling.
  PUSH_WORKER_ENABLED: 'false',
  STORY_SWEEP_INTERVAL_SECONDS: '0',
  // Test passwords such as "correct horse battery staple" are famous leaks; auth.e2e turns it on against a stand-in.
  PASSWORD_BREACH_CHECK: 'off',
};

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

/** Drops and recreates the test schema, so every run starts from the migrations alone. */
export async function resetDatabase(url = TEST_ENV.DATABASE_URL) {
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export interface TestContext {
  app: NestFastifyApplication;
  mail: MailService;
  close: () => Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const redis = new Redis(TEST_ENV.REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  const app = await createApp(testConfig(overrides), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, mail: app.get(MailService), close: () => app.close() };
}

let counter = 0;
export function uniqueUser(prefix = 'user') {
  counter += 1;
  const tag = `${prefix}${process.pid % 10000}_${counter}`;
  return { email: `${tag}@example.test`, username: tag.toLowerCase(), password: 'correct horse battery staple', displayName: `Test ${tag}` };
}

export async function req(app: NestFastifyApplication, method: string, url: string, opts: { body?: unknown; token?: string; ip?: string } = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: opts.body as object | undefined,
    remoteAddress: opts.ip,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : undefined, headers: res.headers };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function linkToken(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('No token in email');
  return m[1];
}

let ipCounter = 0;
/** Distinct client IPs so per-IP rate limits apply per simulated client, as in production. */
export function nextIp() {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export interface TestUser {
  id: string;
  token: string;
  sessionId: string;
  username: string;
  password: string;
}

/** Registers a fresh user and returns its id and access token. */
export async function registerUser(app: NestFastifyApplication, prefix = 'u'): Promise<TestUser> {
  const u = uniqueUser(prefix);
  const res = await req(app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const me = await req(app, 'GET', '/v1/me', { token: res.body.accessToken });
  return { id: me.body.id, token: res.body.accessToken, sessionId: res.body.sessionId, username: u.username, password: u.password };
}

let clientCounter = 0;
/** A fresh client-side message id, as a device would generate. */
export function clientId() {
  clientCounter += 1;
  return `c${process.pid}x${clientCounter}x${Math.random().toString(36).slice(2, 10)}`;
}

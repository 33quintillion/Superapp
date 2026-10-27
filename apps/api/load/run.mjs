// Load tests (Stage 9): starts the built API against real Postgres and Redis, seeds data
// straight into the database, then drives it over HTTP and WebSockets and prints latencies.
// Prereqs: Postgres and Redis running, an empty-or-scratch database, and `pnpm --filter @nexa/api build`.
//
//   LOAD_DATABASE_URL  scratch database (default superapp_load; its tables are rebuilt by the migrations)
//   LOAD_ONLY          fanout, throughput, presence or feed, to run one scenario
//   LOAD_SCALE         multiplies the sizes below (default 1)
//
// Rate limits are turned off: this measures capacity, not the abuse limits.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(apiDir, 'package.json'));
const { Pool } = require('pg');
const { SignJWT } = require('jose');
const { WebSocket } = require('ws');
const Redis = require('ioredis');

const PORT = 3200;
const API = `http://127.0.0.1:${PORT}`;
const SCALE = Number(process.env.LOAD_SCALE ?? 1);
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  DATABASE_URL: process.env.LOAD_DATABASE_URL ?? 'postgres://superapp:superapp_dev@localhost:5432/superapp_load',
  DATABASE_POOL_MAX: process.env.LOAD_POOL_MAX ?? '20',
  REDIS_URL: process.env.LOAD_REDIS_URL ?? 'redis://localhost:6379/13',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SMTP_URL: 'smtp://127.0.0.1:2526',
  LOG_LEVEL: 'warn',
  RATE_LIMIT_DISABLED: 'true',
  S3_ENDPOINT: process.env.LOAD_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  S3_BUCKET: 'nexa-load',
  S3_ACCESS_KEY_ID: process.env.LOAD_S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.LOAD_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_AUTO_CREATE_BUCKET: 'true',
  STUN_URLS: 'stun:stun.example.test:3478',
  // The default heartbeat; long enough that it doesn't skew a short run.
  WS_HEARTBEAT_SECONDS: '25',
};

const db = new Pool({ connectionString: env.DATABASE_URL, max: 8 });
const results = [];

// ------------------------------------------------------------------ helpers

function pct(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function summary(xs) {
  return { n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), p99: Math.round(pct(xs, 99)), max: Math.round(Math.max(...xs)) };
}
function report(name, fields) {
  results.push({ name, ...fields });
  console.log(`  ${name}: ${JSON.stringify(fields)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** People are inserted directly, with live sessions, and get access tokens signed with the API's key. */
async function seedUsers(n, prefix) {
  const ids = [];
  const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  const { rows } = await db.query(
    `WITH u AS (
       INSERT INTO users (email, username, display_name, email_verified_at)
       SELECT $2 || i || '@load.test', $2 || i, 'Load ' || i, now() FROM generate_series(1, $1) i RETURNING id)
     INSERT INTO privacy_settings (user_id) SELECT id FROM u RETURNING user_id`,
    [n, prefix],
  );
  const sessions = await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     SELECT u, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), now() + interval '1 day' FROM unnest($1::uuid[]) u RETURNING id, user_id`,
    [rows.map((r) => r.user_id)],
  );
  for (const s of sessions.rows) {
    const token = await new SignJWT({ sid: s.id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(s.user_id)
      .setIssuer('nexa-api')
      .setAudience('nexa-clients')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(key);
    ids.push({ id: s.user_id, token });
  }
  return ids;
}

async function http(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A WebSocket client that records the time each message arrives. */
class Socket {
  constructor(user) {
    this.user = user;
    this.handlers = new Set();
    this.acks = new Map();
  }
  async open() {
    const t0 = performance.now();
    const { ticket, path } = await http('POST', '/v1/realtime/tickets', this.user.token);
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?ticket=${ticket}`);
    await new Promise((resolve, reject) => {
      this.ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'ready') resolve();
        if (f.type === 'ack' || f.type === 'error') {
          const done = this.acks.get(f.ref);
          if (done) this.acks.delete(f.ref), done(f);
        }
        for (const h of this.handlers) h(f);
      });
      this.ws.on('error', reject);
      this.ws.on('unexpected-response', (_, res) => reject(new Error(`upgrade ${res.statusCode}`)));
    });
    return performance.now() - t0;
  }
  send(conversationId, body) {
    const ref = randomUUID();
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.acks.set(ref, (f) => resolve({ ok: f.type === 'ack', ms: performance.now() - t0, error: f.error }));
      this.ws.send(JSON.stringify({ type: 'send', ref, conversationId, message: { clientId: `ld${randomBytes(8).toString('hex')}`, body } }));
    });
  }
  close() {
    return new Promise((r) => {
      if (this.ws.readyState === WebSocket.CLOSED) return r();
      this.ws.once('close', r);
      this.ws.close();
    });
  }
}

async function openAll(users, concurrency = 50) {
  const sockets = users.map((u) => new Socket(u));
  const times = [];
  for (let i = 0; i < sockets.length; i += concurrency) {
    times.push(...(await Promise.all(sockets.slice(i, i + concurrency).map((s) => s.open()))));
  }
  return { sockets, times };
}

// ------------------------------------------------------------------ scenarios

/**
 * Fan-out: one sender in a group, every other member online. Latency is from the send to the
 * moment each member's socket receives message.created, so it covers the row lock on the
 * conversation counter, the insert, Redis pub/sub, and the write to every socket.
 */
async function fanout() {
  for (const size of [2, 50, 256]) {
    const users = await seedUsers(size, `fo${size}_`);
    const [owner, ...others] = users;
    const conv = size === 2
      ? (await http('POST', '/v1/conversations/direct', owner.token, { userId: others[0].id })).id
      : (await http('POST', '/v1/conversations/groups', owner.token, { title: `Load ${size}`, memberIds: others.map((u) => u.id) })).id;
    const { sockets } = await openAll(users);
    const delivery = [];
    const acks = [];
    for (const s of sockets.slice(1)) {
      s.handlers.add((f) => {
        if (f.type === 'message.created' && f.data.body?.startsWith('t:')) delivery.push(Date.now() - Number(f.data.body.slice(2)));
      });
    }
    const messages = Math.round(40 * SCALE);
    const t0 = performance.now();
    // Five messages a second from one person: a busy group, and the shape of a burst.
    for (let i = 0; i < messages; i++) {
      const r = await Promise.all([sockets[0].send(conv, `t:${Date.now()}`), sleep(200)]);
      if (!r[0].ok) throw new Error(`send failed: ${JSON.stringify(r[0].error)}`);
      acks.push(r[0].ms);
    }
    await sleep(1000);
    const expected = messages * (size - 1);
    report(`fan-out to a ${size === 2 ? 'direct chat' : `group of ${size}`}`, {
      messages,
      deliveries: `${delivery.length}/${expected}`,
      sendAckMs: summary(acks),
      deliveryMs: summary(delivery),
      seconds: Math.round((performance.now() - t0) / 1000),
    });
    if (delivery.length !== expected) throw new Error(`lost deliveries: ${delivery.length}/${expected}`);
    await Promise.all(sockets.map((s) => s.close()));
  }
}

/**
 * Many busy direct chats at once: every pair sends as fast as its acks come back. This is
 * the write path (row lock, insert, publish) under contention on the database pool.
 */
async function throughput() {
  const pairs = Math.round(100 * SCALE);
  const users = await seedUsers(pairs * 2, 'tp_');
  const convs = [];
  for (let i = 0; i < pairs; i++) convs.push((await http('POST', '/v1/conversations/direct', users[2 * i].token, { userId: users[2 * i + 1].id })).id);
  const { sockets } = await openAll(users);
  let received = 0;
  for (const s of sockets) s.handlers.add((f) => f.type === 'message.created' && received++);
  const acks = [];
  let errors = 0;
  const seconds = 20;
  const until = performance.now() + seconds * 1000;
  await Promise.all(
    convs.map(async (conv, i) => {
      const s = sockets[2 * i];
      while (performance.now() < until) {
        const r = await s.send(conv, 'x');
        if (r.ok) acks.push(r.ms);
        else errors++;
      }
    }),
  );
  await sleep(1000);
  report(`${pairs} direct chats sending flat out for ${seconds}s`, {
    messagesPerSecond: Math.round(acks.length / seconds),
    errors,
    // Each message reaches the sender's socket and the recipient's.
    eventsReceived: `${received}/${acks.length * 2}`,
    sendAckMs: summary(acks),
  });
  await Promise.all(sockets.map((s) => s.close()));
}

/** Presence: a crowd connects, everyone's contacts see them come online, then they all leave. */
async function presence() {
  const n = Math.round(1000 * SCALE);
  const users = await seedUsers(n, 'pr_');
  // Everyone has a direct chat with the next person, so each connection announces presence to someone.
  const pairs = [];
  for (let i = 0; i + 1 < n; i += 2) pairs.push([users[i], users[i + 1]]);
  const keys = pairs.map(([a, b]) => [a.id, b.id].sort().join(':'));
  const convs = await db.query(
    `INSERT INTO conversations (kind, direct_key) SELECT 'direct', k FROM unnest($1::text[]) WITH ORDINALITY AS t(k, i) ORDER BY i RETURNING id, direct_key`,
    [keys],
  );
  const byKey = new Map(convs.rows.map((r) => [r.direct_key, r.id]));
  await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id) SELECT c, u FROM unnest($1::uuid[], $2::uuid[]) AS t(c, u)`,
    [keys.flatMap((k) => [byKey.get(k), byKey.get(k)]), pairs.flatMap(([a, b]) => [a.id, b.id])],
  );
  let presenceEvents = 0;
  const t0 = performance.now();
  const { sockets, times } = await openAll(users, 100);
  const connectSeconds = (performance.now() - t0) / 1000;
  for (const s of sockets) s.handlers.add((f) => f.type === 'presence' && !f.data.online && presenceEvents++);
  const rssBefore = await apiMemory();
  await sleep(2000);
  // One person in each chat leaves; the other should see them go offline.
  const t1 = performance.now();
  await Promise.all(sockets.filter((_, i) => i % 2 === 0).map((s) => s.close()));
  await sleep(2000);
  report(`${n} sockets connecting, 100 at a time`, {
    connectsPerSecond: Math.round(n / connectSeconds),
    connectMs: summary(times),
    apiRssMb: rssBefore,
    disconnectSeconds: Math.round((performance.now() - t1) / 100) / 10,
    offlineEventsSeen: `${presenceEvents}/${n / 2}`,
  });
  await Promise.all(sockets.map((s) => s.close()));
}

/**
 * The feed is built on read: posts by the people you follow, your communities, and your own,
 * newest first, each checked against the visibility rules. Measured for a typical account
 * and for one that follows few people in a large table, the worst case for that query.
 */
async function feed() {
  const authors = Math.round(2000 * SCALE);
  const users = await seedUsers(authors, 'fd_');
  const ids = users.map((u) => u.id);
  const t0 = performance.now();
  // 50 posts each, spread over 30 days.
  await db.query(
    `INSERT INTO posts (author_id, client_id, audience, body, created_at)
     SELECT a, 'ld' || md5(a::text || i), CASE WHEN i % 10 = 0 THEN 'followers' ELSE 'public' END, 'post ' || i,
            date_trunc('milliseconds', now() - (random() * interval '30 days'))
       FROM unnest($1::uuid[]) a, generate_series(1, 50) i`,
    [ids],
  );
  // Typical viewers follow 150 random people; sparse viewers follow 5.
  const typical = users.slice(0, 50);
  const sparse = users.slice(50, 100);
  await db.query(
    `INSERT INTO follows (follower_id, followee_id, state, accepted_at)
     SELECT v, f, 'active', now() FROM unnest($1::uuid[]) v,
       LATERAL (SELECT id AS f FROM users WHERE id <> v AND username LIKE 'fd\\_%' ORDER BY random() LIMIT 150) x`,
    [typical.map((u) => u.id)],
  );
  await db.query(
    `INSERT INTO follows (follower_id, followee_id, state, accepted_at)
     SELECT v, f, 'active', now() FROM unnest($1::uuid[]) v,
       LATERAL (SELECT id AS f FROM users WHERE id <> v AND username LIKE 'fd\\_%' ORDER BY random() LIMIT 5) x`,
    [sparse.map((u) => u.id)],
  );
  await db.query('ANALYZE posts; ANALYZE follows');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM posts');
  console.log(`  seeded ${rows[0].n} posts in ${Math.round((performance.now() - t0) / 1000)}s`);

  for (const [label, viewers] of [['following 150', typical], ['following 5', sparse]]) {
    const first = [];
    const second = [];
    const seconds = 15;
    const until = performance.now() + seconds * 1000;
    // 20 people refreshing their feed back to back, then the next page.
    await Promise.all(
      Array.from({ length: 20 }, async (_, w) => {
        let k = w;
        while (performance.now() < until) {
          const v = viewers[k++ % viewers.length];
          let t = performance.now();
          const page = await http('GET', '/v1/feed?limit=20', v.token);
          first.push(performance.now() - t);
          if (page.nextCursor) {
            t = performance.now();
            await http('GET', `/v1/feed?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`, v.token);
            second.push(performance.now() - t);
          }
        }
      }),
    );
    report(`feed, ${label}, 20 concurrent readers`, {
      requestsPerSecond: Math.round((first.length + second.length) / seconds),
      firstPageMs: summary(first),
      nextPageMs: summary(second),
    });
  }
}

async function apiMemory() {
  const pid = api.pid;
  try {
    const { readFileSync } = await import('node:fs');
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ run

function exec(cmd, args, opts) {
  return new Promise((res, rej) => spawn(cmd, args, { stdio: 'inherit', ...opts }).on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`)))));
}

let api;
let failed = false;
try {
  // Start from an empty schema so the sizes above are what is measured.
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await exec('node', ['dist/src/database/migrate.cli.js'], { cwd: apiDir, env });
  const redis = new Redis(env.REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  api = spawn('node', ['dist/src/main.js'], { cwd: apiDir, env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${API}/health/ready`)).ok) break;
    } catch {}
    if (i > 60) throw new Error('API did not start');
    await sleep(500);
  }
  const scenarios = { fanout, throughput, presence, feed };
  const only = process.env.LOAD_ONLY;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && only !== name) continue;
    console.log(`\n${name}`);
    await fn();
  }
  console.log(`\nLoad results (JSON):\n${JSON.stringify(results, null, 2)}`);
} catch (err) {
  failed = true;
  console.error('\nLoad test FAILED:', err.stack ?? err.message);
} finally {
  api?.kill('SIGTERM');
  await db.end();
  process.exit(failed ? 1 : 0);
}

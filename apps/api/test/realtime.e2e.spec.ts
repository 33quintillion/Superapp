import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { clientId, registerUser, req, startApp, TestContext, TestUser } from './helpers';

interface Frame {
  type: string;
  ref?: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string };
}

/** A WebSocket client that records every frame so tests can wait for specific ones. */
class Client {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private closeWaiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.resolve(f), false) : true));
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.closeWaiters.forEach((r) => r());
    });
  }

  next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const seen = this.frames.find(pred);
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames)}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f);
        },
      });
    });
  }

  /** Resolves true if a matching frame arrives within the window (used to assert absence). */
  async receives(pred: (f: Frame) => boolean, windowMs = 400) {
    return this.next(pred, windowMs).then(
      () => true,
      () => false,
    );
  }

  send(f: object) {
    this.ws.send(JSON.stringify(f));
  }

  waitClosed(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(t);
        resolve(this.closed!);
      });
    });
  }

  close() {
    this.ws.close();
    return this.waitClosed();
  }
}

let ctx: TestContext;
let base: string;
const open: Client[] = [];

async function listen(c: TestContext) {
  await c.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = c.app.getHttpServer().address() as AddressInfo;
  return `127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  ctx = await startApp({ WS_SESSION_RECHECK_SECONDS: '1', CORS_ORIGINS: 'https://app.example.test' });
  base = await listen(ctx);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => (c.closed ? null : c.close())));
});
afterAll(async () => {
  await ctx.close();
});

const user = () => registerUser(ctx.app, 'rt');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function ticket(u: TestUser): Promise<string> {
  const r = await call('POST', '/v1/realtime/tickets', u);
  expect(r.status).toBe(201);
  return r.body.ticket;
}

/** Opens a socket; resolves with the HTTP status if the upgrade is refused. */
function rawConnect(host: string, query: string, headers: Record<string, string> = {}): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/v1/realtime${query}`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => resolve(-1));
  });
}

async function connect(u: TestUser, host = base): Promise<Client> {
  const ws = await rawConnect(host, `?ticket=${await ticket(u)}`);
  if (typeof ws === 'number') throw new Error(`connect failed: ${ws}`);
  const c = new Client(ws);
  open.push(c);
  await c.next((f) => f.type === 'ready');
  return c;
}

async function direct(a: TestUser, b: TestUser) {
  return (await call('POST', '/v1/conversations/direct', a, { userId: b.id })).body.id as string;
}

describe('connecting', () => {
  it('needs a valid, unused ticket', async () => {
    const a = await user();
    expect(await rawConnect(base, '')).toBe(401);
    expect(await rawConnect(base, '?ticket=nope')).toBe(401);
    // An access token is not a ticket.
    expect(await rawConnect(base, `?ticket=${a.token}`)).toBe(401);
    const t = await ticket(a);
    const ok = await rawConnect(base, `?ticket=${t}`);
    expect(ok).toBeInstanceOf(WebSocket);
    (ok as WebSocket).close();
    expect(await rawConnect(base, `?ticket=${t}`)).toBe(401);
    expect((await req(ctx.app, 'POST', '/v1/realtime/tickets')).status).toBe(401);
  });

  it('refuses browsers from origins that are not allowed', async () => {
    const a = await user();
    expect(await rawConnect(base, `?ticket=${await ticket(a)}`, { origin: 'https://evil.example' })).toBe(403);
    const ok = await rawConnect(base, `?ticket=${await ticket(a)}`, { origin: 'https://app.example.test' });
    expect(ok).toBeInstanceOf(WebSocket);
    (ok as WebSocket).close();
  });

  it('refuses a ticket whose session was signed out, and drops open sockets when it is', async () => {
    const a = await user();
    const t = await ticket(a);
    const c = await connect(a);
    expect((await call('POST', '/v1/auth/logout', a)).status).toBe(204);
    expect(await rawConnect(base, `?ticket=${t}`)).toBe(401);
    expect((await c.waitClosed()).code).toBe(4401);
  });

  it('answers pings and reports bad frames without dropping the connection', async () => {
    const a = await user();
    const c = await connect(a);
    c.send({ type: 'ping', ref: 'p1' });
    expect(await c.next((f) => f.type === 'pong')).toMatchObject({ ref: 'p1' });
    c.ws.send('not json');
    expect((await c.next((f) => f.type === 'error')).error!.code).toBe('bad_frame');
    c.send({ type: 'teleport', ref: 'x' });
    expect(await c.next((f) => f.type === 'error')).toMatchObject({ ref: 'x', error: { code: 'validation_failed' } });
    c.send({ type: 'send', ref: 's', conversationId: '00000000-0000-4000-8000-000000000000', message: { clientId: clientId(), body: 'x' } });
    expect(await c.next((f) => f.type === 'error')).toMatchObject({ ref: 's', error: { code: 'not_found' } });
    c.send({ type: 'ping', ref: 'p2' });
    expect(await c.next((f) => f.type === 'pong')).toMatchObject({ ref: 'p2' });
  });
});

describe('live delivery', () => {
  it('acks the sender and delivers to every device of both people', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const [a1, a2, b1] = [await connect(a), await connect(a), await connect(b)];
    const id = clientId();
    a1.send({ type: 'send', ref: 'r1', conversationId: cid, message: { clientId: id, body: 'over the wire' } });
    const ack = await a1.next((f) => f.type === 'ack' && f.ref === 'r1');
    expect(ack.data).toMatchObject({ duplicate: false, message: { clientId: id, body: 'over the wire', senderId: a.id } });
    for (const c of [a1, a2, b1]) {
      const e = await c.next((f) => f.type === 'message.created');
      expect(e.data).toMatchObject({ id: ack.data.message.id, conversationId: cid, seq: ack.data.message.seq });
    }
    // REST sends are pushed too.
    await call('POST', `/v1/conversations/${cid}/messages`, b, { clientId: clientId(), body: 'via rest' });
    expect((await a2.next((f) => f.type === 'message.created')).data.body).toBe('via rest');
  });

  it('pushes edits, reactions, deletes and receipts', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'v1' })).body.message;
    const [ca, cb] = [await connect(a), await connect(b)];
    await call('PATCH', `/v1/messages/${m.id}`, a, { body: 'v2' });
    expect((await cb.next((f) => f.type === 'message.updated')).data).toMatchObject({ id: m.id, body: 'v2' });
    await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: '🔥' });
    expect((await ca.next((f) => f.type === 'message.updated' && f.data.reactions.length === 1)).data.reactions).toEqual([{ userId: b.id, emoji: '🔥' }]);

    cb.send({ type: 'receipt', ref: 'rr', conversationId: cid, kind: 'read', seq: m.seq });
    expect((await cb.next((f) => f.type === 'ack' && f.ref === 'rr')).data).toMatchObject({ lastReadSeq: m.seq });
    expect((await ca.next((f) => f.type === 'receipt')).data).toMatchObject({ userId: b.id, lastReadSeq: m.seq, lastDeliveredSeq: m.seq });

    await call('DELETE', `/v1/messages/${m.id}`, a);
    expect((await cb.next((f) => f.type === 'message.updated' && f.data.deletedAt)).data.body).toBeNull();
  });

  it('withholds read positions from the other person when read receipts are off', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'hi' })).body.message;
    await call('PATCH', '/v1/me/privacy', b, { showReadReceipts: false });
    const ca = await connect(a);
    await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'read', seq: m.seq });
    expect((await ca.next((f) => f.type === 'receipt')).data).toMatchObject({ userId: b.id, lastDeliveredSeq: m.seq, lastReadSeq: null });
  });

  it('relays typing to the other person only, and not across a block', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const [ca, cb] = [await connect(a), await connect(b)];
    ca.send({ type: 'typing', conversationId: cid, typing: true });
    expect((await cb.next((f) => f.type === 'typing')).data).toEqual({ conversationId: cid, userId: a.id, typing: true });
    ca.send({ type: 'typing', conversationId: cid, typing: false });
    expect((await cb.next((f) => f.type === 'typing')).data.typing).toBe(false);
    expect(await ca.receives((f) => f.type === 'typing')).toBe(false);
    await call('POST', '/v1/blocks', b, { userId: a.id });
    await new Promise((r) => setTimeout(r, 2100)); // past the typing throttle
    ca.send({ type: 'typing', conversationId: cid, typing: true });
    expect(await cb.receives((f) => f.type === 'typing')).toBe(false);
  });
});

describe('presence', () => {
  it('announces online and offline to chat peers who share their status', async () => {
    const [a, b, stranger] = [await user(), await user(), await user()];
    await direct(a, b);
    const ca = await connect(a);
    const cs = await connect(stranger);
    const cb = await connect(b);
    expect((await ca.next((f) => f.type === 'presence')).data).toMatchObject({ userId: b.id, online: true });
    let p = (await call('GET', `/v1/presence?userIds=${b.id},${stranger.id}`, a)).body;
    expect(p).toEqual([
      { userId: b.id, online: true, lastSeenAt: null },
      { userId: stranger.id, online: null, lastSeenAt: null },
    ]);
    await cb.close();
    expect((await ca.next((f) => f.type === 'presence')).data).toMatchObject({ userId: b.id, online: false });
    p = (await call('GET', `/v1/presence?userIds=${b.id}`, a)).body;
    expect(p[0].online).toBe(false);
    expect(p[0].lastSeenAt).not.toBeNull();
    expect(await cs.receives((f) => f.type === 'presence')).toBe(false);
  });

  it('stays online while any device is connected, and hides status when either side opts out', async () => {
    const [a, b] = [await user(), await user()];
    await direct(a, b);
    const [b1, b2] = [await connect(b), await connect(b)];
    const ca = await connect(a);
    await b1.close();
    expect(await ca.receives((f) => f.type === 'presence' && f.data.online === false)).toBe(false);
    expect((await call('GET', `/v1/presence?userIds=${b.id}`, a)).body[0].online).toBe(true);
    await call('PATCH', '/v1/me/privacy', a, { showOnlineStatus: false });
    expect((await call('GET', `/v1/presence?userIds=${b.id}`, a)).body[0].online).toBeNull();
    await b2.close();
  });
});

describe('recovery', () => {
  it('a device that was offline catches up from the change feed in order', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const cb = await connect(b);
    const ca = await connect(a);
    ca.send({ type: 'send', ref: 'm0', conversationId: cid, message: { clientId: clientId(), body: 'seen live' } });
    const live = await cb.next((f) => f.type === 'message.created');
    const lastSeen = live.data.changeSeq;
    await cb.close();
    for (const body of ['while', 'you', 'were', 'away']) {
      ca.send({ type: 'send', ref: body, conversationId: cid, message: { clientId: clientId(), body } });
      await ca.next((f) => f.type === 'ack' && f.ref === body);
    }
    const back = await connect(b);
    const ch = (await call('GET', `/v1/conversations/${cid}/changes?since=${lastSeen}`, b)).body;
    expect(ch.changes.map((m: { body: string }) => m.body)).toEqual(['while', 'you', 'were', 'away']);
    const seqs = ch.changes.map((m: { seq: number }) => m.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    // ...and live delivery resumes.
    ca.send({ type: 'send', ref: 'after', conversationId: cid, message: { clientId: clientId(), body: 'welcome back' } });
    expect((await back.next((f) => f.type === 'message.created')).data.body).toBe('welcome back');
  });

  it('a resend after a lost ack does not duplicate the message', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const id = clientId();
    const first = await connect(a);
    first.send({ type: 'send', ref: 'lost', conversationId: cid, message: { clientId: id, body: 'exactly once' } });
    // Simulate the connection dying before the ack is read.
    first.ws.terminate();
    await first.waitClosed();
    const second = await connect(a);
    second.send({ type: 'send', ref: 'retry', conversationId: cid, message: { clientId: id, body: 'exactly once' } });
    const ack = await second.next((f) => f.type === 'ack' && f.ref === 'retry');
    const all = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages;
    expect(all.filter((m: { body: string }) => m.body === 'exactly once')).toHaveLength(1);
    expect(ack.data.message.id).toBe(all[0].id);
  });

  it('fans out across API instances through Redis', async () => {
    const other = await startApp({ CORS_ORIGINS: 'https://app.example.test' });
    try {
      const otherBase = await listen(other);
      const [a, b] = [await user(), await user()];
      const cid = await direct(a, b);
      const ca = await connect(a, base);
      const cb = await connect(b, otherBase);
      ca.send({ type: 'send', ref: 'x', conversationId: cid, message: { clientId: clientId(), body: 'cross-instance' } });
      expect((await cb.next((f) => f.type === 'message.created')).data.body).toBe('cross-instance');
      cb.send({ type: 'typing', conversationId: cid, typing: true });
      expect((await ca.next((f) => f.type === 'typing')).data.userId).toBe(b.id);
    } finally {
      await Promise.all(open.splice(0).map((c) => (c.closed ? null : c.close())));
      await other.close();
    }
  });
});

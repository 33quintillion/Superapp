import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { CallsService } from '../src/calls/calls.service';
import { coturnCredentials } from '../src/calls/ice.service';
import { PushWorker } from '../src/push/push.worker';
import { generateVapidKeys } from '../src/push/webpush';
import { registerUser, req, startApp, TEST_ENV, testConfig, TestContext, TestUser } from './helpers';
import { browserSubscription, decryptWebPush, startWebPushService } from './push-fakes';
import { Client, rawConnect } from './ws-client';

// Real API, Postgres and Redis, with real WebSocket clients standing in for the devices.
// The SDP and candidates are opaque to the server, so these tests check that they reach
// exactly the right device, and that every way a call can end is recorded correctly.
let ctx: TestContext;
let base: string;
let pool: Pool;
let calls: CallsService;
let worker: PushWorker;
let webpush: Awaited<ReturnType<typeof startWebPushService>>;
const open: Client[] = [];
const vapid = generateVapidKeys();

beforeAll(async () => {
  webpush = await startWebPushService();
  ctx = await startApp({
    // Timeouts are forced by back-dating rows, then sweeping by hand.
    CALL_SWEEP_INTERVAL_MS: '0',
    TURN_PROVIDER: 'coturn',
    TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349',
    TURN_SHARED_SECRET: 'coturn-test-secret',
    STUN_URLS: 'stun:stun.example.test:3478',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:ops@example.test',
    WEBPUSH_ALLOWED_HOSTS: '127.0.0.1',
  });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
  calls = ctx.app.get(CallsService);
  worker = ctx.app.get(PushWorker);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => (c.closed ? null : c.close())));
});
afterAll(async () => {
  await ctx.close();
  await pool.end();
  await webpush.close();
});

const user = () => registerUser(ctx.app, 'call');
const api = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

/** A signed-in device with its realtime connection. */
interface Device extends Client {
  id: string;
}

async function connect(u: TestUser): Promise<Device> {
  const t = (await api('POST', '/v1/realtime/tickets', u)).body.ticket;
  const ws = await rawConnect(base, `?ticket=${t}`);
  if (typeof ws === 'number') throw new Error(`connect failed: ${ws}`);
  const c = new Client(ws) as Device;
  open.push(c);
  c.id = (await c.next((f) => f.type === 'ready')).data.connectionId;
  return c;
}

let refs = 0;
/** Sends a frame and waits for its ack (resolves with data) or error (rejects with the code). */
async function rpc(c: Client, frame: Record<string, unknown>): Promise<any> {
  const ref = `r${(refs += 1)}`;
  c.send({ ...frame, ref });
  const f = await c.next((x) => x.ref === ref && (x.type === 'ack' || x.type === 'error'));
  if (f.type === 'error') throw new Error(f.error!.code);
  return f.data;
}

const updated = (c: Client, pred: (call: any) => boolean = () => true) => c.next((f) => f.type === 'call.updated' && pred(f.data));
const signalled = (c: Client, kind: string) => c.next((f) => f.type === 'call.signal' && f.data.signal.kind === kind);

async function direct(a: TestUser, b: TestUser) {
  return (await api('POST', '/v1/conversations/direct', a, { userId: b.id })).body.id as string;
}

/** Notices in the chat history, as the person sees them. */
async function callNotices(u: TestUser, conversationId: string) {
  const r = await api('GET', `/v1/conversations/${conversationId}/messages`, u);
  return r.body.messages.filter((m: any) => m.kind === 'system' && m.system?.type === 'call').map((m: any) => m.system);
}

/** Ana calls Ben, Ben answers on one device, and the two devices finish the WebRTC handshake. */
async function connectedCall(media: 'audio' | 'video' = 'video') {
  const ana = await user();
  const ben = await user();
  const conversationId = await direct(ana, ben);
  const a = await connect(ana);
  const b = await connect(ben);
  const call = await rpc(a, { type: 'call.start', conversationId, media });
  await updated(b, (c) => c.state === 'ringing');
  await rpc(b, { type: 'call.accept', callId: call.id });
  await updated(a, (c) => c.state === 'accepted');
  await rpc(a, { type: 'call.signal', callId: call.id, signal: { kind: 'offer', sdp: 'v=0 offer' } });
  await signalled(b, 'offer');
  await rpc(b, { type: 'call.signal', callId: call.id, signal: { kind: 'answer', sdp: 'v=0 answer' } });
  await signalled(a, 'answer');
  await rpc(a, { type: 'call.connected', callId: call.id });
  await updated(b, (c) => c.state === 'connected');
  return { ana, ben, a, b, conversationId, callId: call.id as string };
}

async function backdate(callId: string, column: string, seconds: number) {
  await pool.query(`UPDATE calls SET ${column} = now() - make_interval(secs => $2) WHERE id = $1`, [callId, seconds]);
}

describe('ringing and answering', () => {
  it('rings every device of the callee, and only the answering device takes part', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const phone = await connect(ben);
    const laptop = await connect(ben);

    const call = await rpc(a, { type: 'call.start', conversationId, media: 'video' });
    expect(call).toMatchObject({ state: 'ringing', media: 'video', callerId: ana.id, calleeId: ben.id, callerConnectionId: a.id, calleeConnectionId: null });
    for (const d of [phone, laptop]) expect((await updated(d)).data).toMatchObject({ id: call.id, state: 'ringing' });
    // A device that connects while it rings can pick the call up.
    expect((await api('GET', '/v1/calls/active', ben)).body.call).toMatchObject({ id: call.id, state: 'ringing' });

    await rpc(phone, { type: 'call.accept', callId: call.id });
    // The laptop learns the call was answered elsewhere, so it stops ringing.
    expect((await updated(laptop, (c) => c.state === 'accepted')).data.calleeConnectionId).toBe(phone.id);
    await expect(rpc(laptop, { type: 'call.accept', callId: call.id })).rejects.toThrow('call_not_ringing');

    await rpc(a, { type: 'call.signal', callId: call.id, signal: { kind: 'offer', sdp: 'v=0 offer' } });
    expect((await signalled(phone, 'offer')).data).toEqual({ callId: call.id, from: ana.id, signal: { kind: 'offer', sdp: 'v=0 offer' } });
    expect(await laptop.receives((f) => f.type === 'call.signal')).toBe(false);
    // A device not in the call cannot inject signalling.
    await expect(rpc(laptop, { type: 'call.signal', callId: call.id, signal: { kind: 'answer', sdp: 'x' } })).rejects.toThrow('call_not_active');

    await rpc(phone, { type: 'call.signal', callId: call.id, signal: { kind: 'answer', sdp: 'v=0 answer' } });
    await signalled(a, 'answer');
    const cand = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    phone.send({ type: 'call.signal', callId: call.id, signal: { kind: 'candidate', candidate: cand } });
    expect((await signalled(a, 'candidate')).data.signal.candidate).toEqual(cand);
    phone.send({ type: 'call.signal', callId: call.id, signal: { kind: 'candidate', candidate: null } });
    expect((await signalled(a, 'candidate')).data.signal.candidate).toBeNull();

    await rpc(phone, { type: 'call.connected', callId: call.id });
    expect((await updated(a, (c) => c.state === 'connected')).data.connectedAt).not.toBeNull();
  });

  it('records a completed call with its length, in history and in the chat', async () => {
    const { ana, ben, a, b, conversationId, callId } = await connectedCall('audio');
    await backdate(callId, 'connected_at', 125);
    const ended = await rpc(b, { type: 'call.hangup', callId });
    expect(ended).toMatchObject({ state: 'ended', endReason: 'completed', endedBy: ben.id });
    expect(ended.durationSeconds).toBeGreaterThanOrEqual(125);
    expect((await updated(a, (c) => c.state === 'ended')).data.endReason).toBe('completed');
    expect((await a.next((f) => f.type === 'message.created')).data.system).toMatchObject({ type: 'call', outcome: 'completed', media: 'audio' });

    expect(await callNotices(ben, conversationId)).toEqual([{ type: 'call', callId, media: 'audio', outcome: 'completed', durationSeconds: ended.durationSeconds }]);
    const mine = (await api('GET', '/v1/calls', ana)).body.calls;
    expect(mine[0]).toMatchObject({ id: callId, direction: 'outgoing', endReason: 'completed', peer: { id: ben.id } });
    expect((await api('GET', '/v1/calls', ben)).body.calls[0]).toMatchObject({ id: callId, direction: 'incoming', peer: { id: ana.id } });
    // Hanging up twice is harmless; the line is free again for a new call.
    expect((await api('POST', `/v1/calls/${callId}/hangup`, ana, {})).body.endReason).toBe('completed');
    expect((await rpc(a, { type: 'call.start', conversationId, media: 'audio' })).state).toBe('ringing');
    // The notice is part of the chat's history, but not something anyone can edit.
    const notice = (await api('GET', `/v1/conversations/${conversationId}/messages`, ana)).body.messages.find((m: any) => m.system?.callId === callId);
    expect((await api('PATCH', `/v1/messages/${notice.id}`, ana, { body: 'edited' })).status).toBe(409);
  });

  it('declining ends the call for everyone and does not send a missed-call notification', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const b = await connect(ben);
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'audio' });
    await updated(b);
    await rpc(b, { type: 'call.decline', callId: call.id });
    expect((await updated(a, (c) => c.state === 'ended')).data).toMatchObject({ endReason: 'declined', endedBy: ben.id });
    expect((await pool.query('SELECT 1 FROM push_jobs j JOIN messages m ON m.id = j.message_id WHERE m.conversation_id = $1', [conversationId])).rowCount).toBe(0);
    // Too late to answer a declined call.
    await expect(rpc(b, { type: 'call.accept', callId: call.id })).rejects.toThrow('call_not_ringing');
  });

  it('the caller hanging up while it rings cancels it', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'video' });
    expect((await rpc(a, { type: 'call.hangup', callId: call.id })).endReason).toBe('cancelled');
    expect(await callNotices(ben, conversationId)).toEqual([expect.objectContaining({ outcome: 'cancelled', media: 'video' })]);
  });

  it('only one of two devices answering at once gets the call', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const [p, q] = [await connect(ben), await connect(ben)];
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'audio' });
    const results = await Promise.allSettled([rpc(p, { type: 'call.accept', callId: call.id }), rpc(q, { type: 'call.accept', callId: call.id })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(['call_not_ringing']);
  });
});

describe('missed calls', () => {
  it('a call nobody answers rings out as missed, and the callee gets a notification', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    // Ben has this browser subscribed to notifications, but no app open.
    const sub = browserSubscription();
    const endpoint = webpush.endpoint();
    expect((await api('PUT', '/v1/push/devices/current', ben, { provider: 'webpush', endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })).status).toBe(200);
    const a = await connect(ana);
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'video' });

    expect(await calls.sweep()).toEqual([]); // not yet
    await backdate(call.id, 'created_at', 46);
    expect((await calls.sweep()).map((c) => [c.id, c.endReason])).toEqual([[call.id, 'missed']]);
    expect((await updated(a, (c) => c.state === 'ended')).data.endReason).toBe('missed');
    expect(await calls.sweep()).toEqual([]); // ended exactly once

    await worker.runOnce();
    const path = new URL(endpoint).pathname;
    const delivered = webpush.requests.filter((r) => r.path === path).map((r) => JSON.parse(decryptWebPush(r.body, sub).toString()));
    expect(delivered).toEqual([expect.objectContaining({ title: expect.stringContaining('Test call'), body: 'Missed video call', data: expect.objectContaining({ type: 'missed_call', conversationId }) })]);
    expect((await api('GET', '/v1/calls', ben)).body.calls[0]).toMatchObject({ id: call.id, direction: 'incoming', endReason: 'missed', durationSeconds: 0 });
  });

  it('calling someone already on a call ends at once as busy', async () => {
    const { ana, ben, a } = await connectedCall();
    const cara = await user();
    const c = await connect(cara);
    const withBen = await direct(cara, ben);
    const r = await rpc(c, { type: 'call.start', conversationId: withBen, media: 'audio' });
    expect(r).toMatchObject({ state: 'ended', endReason: 'busy' });
    expect(await callNotices(ben, withBen)).toEqual([expect.objectContaining({ outcome: 'busy' })]);
    // And someone on a call cannot start a second one.
    await expect(rpc(a, { type: 'call.start', conversationId: await direct(ana, cara), media: 'audio' })).rejects.toThrow('already_in_call');
  });

  it('two people calling each other at the same moment get one call, not a deadlock', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const b = await connect(ben);
    const results = await Promise.allSettled([
      rpc(a, { type: 'call.start', conversationId, media: 'audio' }),
      rpc(b, { type: 'call.start', conversationId, media: 'audio' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<any>).value);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.message);
    const ringing = ok.filter((c) => c.state === 'ringing');
    expect(ringing).toHaveLength(1);
    // The other side either got "already in a call" or a call that ended as busy.
    expect([...failed, ...ok.filter((c) => c.state === 'ended').map((c) => c.endReason)]).toEqual([expect.stringMatching(/^(already_in_call|busy)$/)]);
  });
});

describe('failures and recovery', () => {
  it('an answered call whose media never connects ends as failed', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const b = await connect(ben);
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'video' });
    await rpc(b, { type: 'call.accept', callId: call.id });
    await backdate(call.id, 'answered_at', 31);
    expect((await calls.sweep()).map((c) => c.endReason)).toEqual(['failed']);
    expect((await updated(b, (c) => c.state === 'ended')).data.endReason).toBe('failed');
  });

  it('a device can report that the media connection failed', async () => {
    const { a, b, callId } = await connectedCall();
    expect((await rpc(a, { type: 'call.hangup', callId, failed: true })).endReason).toBe('failed');
    await updated(b, (c) => c.state === 'ended' && c.endReason === 'failed');
  });

  it('a dropped connection can come back within the grace period', async () => {
    const { ben, a, b, callId } = await connectedCall();
    await b.close();
    expect((await updated(a, (c) => c.calleeReconnecting)).data.state).toBe('connected');
    // Not yet past the grace period: nothing ends.
    expect(await calls.sweep()).toEqual([]);

    const b2 = await connect(ben);
    expect((await api('GET', '/v1/calls/active', ben)).body.call).toMatchObject({ id: callId, calleeReconnecting: true });
    const resumed = await rpc(b2, { type: 'call.resume', callId });
    expect(resumed).toMatchObject({ calleeConnectionId: b2.id, calleeReconnecting: false, state: 'connected' });
    await updated(a, (c) => !c.calleeReconnecting && c.calleeConnectionId === b2.id);
    // Signalling now reaches the new connection (the caller restarts ICE).
    await rpc(a, { type: 'call.signal', callId, signal: { kind: 'offer', sdp: 'v=0 ice restart' } });
    expect((await signalled(b2, 'offer')).data.signal.sdp).toBe('v=0 ice restart');
  });

  it('a device that does not come back ends the call as connection lost', async () => {
    const { a, b, callId } = await connectedCall();
    await b.close();
    await updated(a, (c) => c.calleeReconnecting);
    await backdate(callId, 'callee_lost_at', 21);
    expect((await calls.sweep()).map((c) => c.endReason)).toEqual(['connection_lost']);
    await updated(a, (c) => c.state === 'ended' && c.endReason === 'connection_lost');
  });

  it('a caller whose connection drops while it rings cancels the call after the grace period', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const b = await connect(ben);
    const call = await rpc(a, { type: 'call.start', conversationId, media: 'audio' });
    await a.close();
    await updated(b, (c) => c.callerReconnecting);
    await backdate(call.id, 'caller_lost_at', 21);
    expect((await calls.sweep()).map((c) => c.endReason)).toEqual(['cancelled']);
  });

  it('a resumed call cannot be resumed after it ended', async () => {
    const { ana, a, callId } = await connectedCall();
    await rpc(a, { type: 'call.hangup', callId });
    const a2 = await connect(ana);
    await expect(rpc(a2, { type: 'call.resume', callId })).rejects.toThrow('call_ended');
  });
});

describe('who can call whom', () => {
  it('refuses blocked people, group chats, strangers to the chat and bad frames', async () => {
    const ana = await user();
    const ben = await user();
    const cara = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const c = await connect(cara);

    // Cara is not in Ana and Ben's chat.
    await expect(rpc(c, { type: 'call.start', conversationId, media: 'audio' })).rejects.toThrow('not_found');

    const group = await api('POST', '/v1/conversations/groups', ana, { title: 'Trip', memberIds: [ben.id] });
    expect(group.status).toBe(201);
    await expect(rpc(a, { type: 'call.start', conversationId: group.body.id, media: 'audio' })).rejects.toThrow('group_calls_unsupported');

    expect((await api('POST', '/v1/blocks', ben, { userId: ana.id })).status).toBeLessThan(300);
    await expect(rpc(a, { type: 'call.start', conversationId, media: 'audio' })).rejects.toThrow('cannot_call');

    await expect(rpc(a, { type: 'call.start', conversationId, media: 'hologram' })).rejects.toThrow('validation_failed');
    await expect(rpc(a, { type: 'call.signal', callId: conversationId, signal: { kind: 'offer', sdp: 'x'.repeat(40_000) } })).rejects.toThrow('validation_failed');
  });

  it('respects "who can message me": strangers cannot ring someone who limits it', async () => {
    const ana = await user();
    const ben = await user();
    expect((await api('PATCH', '/v1/me/privacy', ben, { whoCanMessage: 'nobody' })).status).toBe(200);
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    await expect(rpc(a, { type: 'call.start', conversationId, media: 'audio' })).rejects.toThrow('cannot_call');
  });

  it('keeps calls private to the two people in them', async () => {
    const { callId } = await connectedCall();
    const eve = await user();
    expect((await api('GET', `/v1/calls/${callId}`, eve)).status).toBe(404);
    expect((await api('POST', `/v1/calls/${callId}/hangup`, eve, {})).status).toBe(404);
    expect((await api('GET', '/v1/calls', eve)).body.calls).toEqual([]);
  });

  it('pages call history newest first', async () => {
    const ana = await user();
    const ben = await user();
    const conversationId = await direct(ana, ben);
    const a = await connect(ana);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await rpc(a, { type: 'call.start', conversationId, media: 'audio' });
      await rpc(a, { type: 'call.hangup', callId: c.id });
      ids.push(c.id);
    }
    const p1 = (await api('GET', '/v1/calls?limit=2', ana)).body;
    expect(p1.calls.map((c: any) => c.id)).toEqual([ids[2], ids[1]]);
    const p2 = (await api('GET', `/v1/calls?limit=2&cursor=${p1.nextCursor}`, ana)).body;
    expect(p2.calls.map((c: any) => c.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();
  });

  it('includes call history in the data export', async () => {
    const { ana, callId } = await connectedCall();
    const exported = (await api('GET', '/v1/me/export', ana)).body.calls;
    expect(exported.map((c: any) => c.id)).toContain(callId);
  });
});

describe('ICE servers', () => {
  it('issues coturn credentials that coturn accepts (TURN REST API HMAC)', async () => {
    const ana = await user();
    const r = await api('GET', '/v1/calls/ice-servers', ana);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ iceTransportPolicy: 'all', relay: true });
    const [stun, turn] = r.body.iceServers;
    expect(stun).toEqual({ urls: ['stun:stun.example.test:3478'] });
    expect(turn.urls).toEqual(['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349']);
    const [expiry, uid] = turn.username.split(':');
    expect(uid).toBe(ana.id);
    expect(Number(expiry) * 1000).toBeGreaterThan(Date.now() + 3 * 3600 * 1000);
    expect(turn.credential).toBe(createHmac('sha1', 'coturn-test-secret').update(turn.username).digest('base64'));
  });

  it('coturn helper matches the published scheme', () => {
    const s = coturnCredentials(['turn:x'], 'secret', 'u1', 60, 1_000_000);
    expect(s.username).toBe('1060:u1');
    expect(s.credential).toBe(createHmac('sha1', 'secret').update('1060:u1').digest('base64'));
  });
});

/** A stand-in for Twilio's and Cloudflare's credential APIs that records what it was sent. */
async function fakeProvider(reply: { status: number; body: unknown }) {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      seen.push({ url: rq.url ?? '', headers: rq.headers, body });
      rs.writeHead(reply.status, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, reply, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('managed TURN providers', () => {
  async function iceWith(env: Record<string, string>) {
    const app = await startApp({ CALL_SWEEP_INTERVAL_MS: '0', ...env });
    try {
      const u = await registerUser(app.app, 'ice');
      return (await req(app.app, 'GET', '/v1/calls/ice-servers', { token: u.token })).body;
    } finally {
      await app.close();
    }
  }

  it('Twilio: asks for a token with the API key and passes its servers on', async () => {
    const tw = await fakeProvider({
      status: 201,
      body: {
        ttl: '3600',
        ice_servers: [
          { url: 'stun:global.stun.twilio.com:3478', urls: 'stun:global.stun.twilio.com:3478' },
          { url: 'turn:global.turn.twilio.com:3478?transport=udp', urls: 'turn:global.turn.twilio.com:3478?transport=udp', username: 'tu', credential: 'tc' },
          { urls: 'turn:global.turn.twilio.com:443?transport=tcp', username: 'tu', credential: 'tc' },
        ],
      },
    });
    try {
      const ice = await iceWith({
        TURN_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_API_KEY_SID: 'SK456',
        TWILIO_API_KEY_SECRET: 'shh',
        TWILIO_API_BASE: tw.url,
        TURN_CREDENTIAL_TTL_SECONDS: '3600',
      });
      expect(tw.seen[0]!.url).toBe('/2010-04-01/Accounts/AC123/Tokens.json');
      expect(tw.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('SK456:shh').toString('base64')}`);
      expect(tw.seen[0]!.body).toBe('Ttl=3600');
      expect(ice.relay).toBe(true);
      expect(ice.iceServers).toEqual([
        { urls: ['stun:global.stun.twilio.com:3478'] },
        { urls: ['turn:global.turn.twilio.com:3478?transport=udp'], username: 'tu', credential: 'tc' },
        { urls: ['turn:global.turn.twilio.com:443?transport=tcp'], username: 'tu', credential: 'tc' },
      ]);
    } finally {
      await tw.close();
    }
  });

  it('Cloudflare: generates ICE servers and drops the port 53 URLs browsers block', async () => {
    const cf = await fakeProvider({
      status: 201,
      body: {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'cu',
            credential: 'cc',
          },
        ],
      },
    });
    try {
      const ice = await iceWith({ TURN_PROVIDER: 'cloudflare', CLOUDFLARE_TURN_KEY_ID: 'key1', CLOUDFLARE_TURN_API_TOKEN: 'tok', CLOUDFLARE_TURN_API_BASE: cf.url });
      expect(cf.seen[0]!.url).toBe('/v1/turn/keys/key1/credentials/generate-ice-servers');
      expect(cf.seen[0]!.headers.authorization).toBe('Bearer tok');
      expect(JSON.parse(cf.seen[0]!.body)).toEqual({ ttl: 4 * 3600 });
      expect(ice.iceServers).toEqual([
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'cu', credential: 'cc' },
      ]);
    } finally {
      await cf.close();
    }
  });

  it('falls back to STUN only when the provider is down, and says so', async () => {
    const down = await fakeProvider({ status: 503, body: {} });
    try {
      const ice = await iceWith({
        TURN_PROVIDER: 'cloudflare',
        CLOUDFLARE_TURN_KEY_ID: 'k',
        CLOUDFLARE_TURN_API_TOKEN: 't',
        CLOUDFLARE_TURN_API_BASE: down.url,
        STUN_URLS: 'stun:stun.example.test:3478',
      });
      expect(ice).toEqual({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }], iceTransportPolicy: 'all', relay: false, expiresAt: null });
    } finally {
      await down.close();
    }
  });

  it('refuses incomplete or unsafe TURN configuration at startup', () => {
    expect(() => testConfig({ TURN_PROVIDER: 'coturn', TURN_URLS: 'turn:x:3478' })).toThrow(/TURN_SHARED_SECRET/);
    expect(() => testConfig({ TURN_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC' })).toThrow(/TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET/);
    expect(() => testConfig({ ICE_TRANSPORT_POLICY: 'relay' })).toThrow(/needs a TURN_PROVIDER/);
    expect(() => testConfig({ STUN_URLS: 'http://not-stun' })).toThrow(/Not a STUN\/TURN URL/);
    expect(() => testConfig({ TURN_PROVIDER: 'coturn', TURN_URLS: 'stun:x', TURN_SHARED_SECRET: 's' })).toThrow(/turn: or turns:/);
    expect(() => testConfig({ NODE_ENV: 'production', CLOUDFLARE_TURN_API_BASE: 'http://127.0.0.1:1', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://x', S3_AUTO_CREATE_BUCKET: 'false' })).toThrow(
      /CLOUDFLARE_TURN_API_BASE is for tests only/,
    );
  });
});

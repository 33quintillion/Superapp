import { Pool } from 'pg';
import { MessagingService } from '../src/messaging/messaging.service';
import { clientId, registerUser, req, startApp, TEST_ENV, TestContext, TestUser } from './helpers';

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

const user = () => registerUser(ctx.app, 'x');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function direct(a: TestUser, b: TestUser): Promise<string> {
  const r = await call('POST', '/v1/conversations/direct', a, { userId: b.id });
  expect(r.status).toBe(200);
  return r.body.id;
}

async function group(owner: TestUser, members: TestUser[], settings: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', '/v1/conversations/groups', owner, { title: 'Family', memberIds: members.map((m) => m.id) });
  expect(r.status).toBe(201);
  if (Object.keys(settings).length) expect((await call('PATCH', `/v1/conversations/${r.body.id}/group`, owner, settings)).status).toBe(200);
  return r.body.id;
}

async function send(u: TestUser, cid: string, payload: Record<string, unknown>) {
  return call('POST', `/v1/conversations/${cid}/messages`, u, { clientId: clientId(), ...payload });
}

async function sent(u: TestUser, cid: string, payload: Record<string, unknown>) {
  const r = await send(u, cid, payload);
  if (r.status !== 201) throw new Error(`send failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.message;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function photo(u: TestUser) {
  const created = await call('POST', '/v1/media/uploads', u, { byteSize: PNG.length, kind: 'image', contentType: 'image/png', fileName: 'dot.png', width: 1, height: 1 });
  expect(created.status).toBe(201);
  const put = await fetch(created.body.upload.url, { method: 'PUT', headers: created.body.upload.headers, body: PNG });
  expect(put.status).toBe(200);
  expect((await call('POST', `/v1/media/${created.body.media.id}/complete`, u)).status).toBe(200);
  return created.body.media.id as string;
}

describe('polls', () => {
  it('asks a question, takes one vote per person, and lets people change or take back their vote', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await group(a, [b, c]);
    const poll = await sent(a, cid, { kind: 'poll', body: '  Dinner on Friday?  ', poll: { options: ['Pizza', 'Dosa', 'Thali'] } });
    expect(poll).toMatchObject({ kind: 'poll', body: 'Dinner on Friday?', poll: { options: ['Pizza', 'Dosa', 'Thali'], multiple: false, votes: [] } });

    let r = await call('PUT', `/v1/messages/${poll.id}/vote`, b, { options: [1] });
    expect(r.status).toBe(200);
    expect(r.body.poll.votes).toEqual([{ userId: b.id, option: 1 }]);
    expect((await call('PUT', `/v1/messages/${poll.id}/vote`, c, { options: [0, 1] })).status).toBe(400); // one answer only
    expect((await call('PUT', `/v1/messages/${poll.id}/vote`, c, { options: [5] })).status).toBe(400);
    await call('PUT', `/v1/messages/${poll.id}/vote`, c, { options: [1] });
    r = await call('PUT', `/v1/messages/${poll.id}/vote`, b, { options: [2] });
    expect(r.body.poll.votes).toEqual(expect.arrayContaining([{ userId: c.id, option: 1 }, { userId: b.id, option: 2 }]));
    expect(r.body.poll.votes).toHaveLength(2);
    r = await call('PUT', `/v1/messages/${poll.id}/vote`, b, { options: [] });
    expect(r.body.poll.votes).toEqual([{ userId: c.id, option: 1 }]);

    // Everyone sees the same counts, and the vote moves the change feed.
    const seen = await call('GET', `/v1/conversations/${cid}/messages`, c);
    expect(seen.body.messages.find((m: { id: string }) => m.id === poll.id).poll.votes).toEqual([{ userId: c.id, option: 1 }]);
    expect(r.body.changeSeq).toBeGreaterThan(poll.changeSeq);
  });

  it('allows several answers when asked to, and checks the poll itself', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const poll = await sent(a, cid, { kind: 'poll', body: 'Which days?', poll: { options: ['Mon', 'Tue', 'Wed'], multiple: true } });
    const r = await call('PUT', `/v1/messages/${poll.id}/vote`, b, { options: [2, 0, 2] });
    expect(r.body.poll.votes.map((v: { option: number }) => v.option)).toEqual([0, 2]);

    for (const bad of [
      { kind: 'poll', body: 'Q', poll: { options: ['Only one'] } },
      { kind: 'poll', body: 'Q', poll: { options: ['Same', 'same'] } },
      { kind: 'poll', body: 'Q', poll: { options: Array.from({ length: 13 }, (_, i) => `o${i}`) } },
      { kind: 'poll', body: '   ', poll: { options: ['a', 'b'] } },
      { kind: 'poll', body: 'Q' },
      { kind: 'text', body: 'hi', poll: { options: ['a', 'b'] } },
    ]) {
      expect([bad, (await send(a, cid, bad)).status]).toEqual([bad, 400]);
    }
    const text = await sent(a, cid, { body: 'not a poll' });
    expect((await call('PUT', `/v1/messages/${text.id}/vote`, b, { options: [0] })).status).toBe(409);
    expect((await call('PATCH', `/v1/messages/${poll.id}`, a, { body: 'Edited?' })).status).toBe(409);
    expect((await call('POST', `/v1/messages/${poll.id}/forward`, a, { conversationIds: [cid], clientId: clientId() })).status).toBe(409);
  });

  it('keeps outsiders and blocked people out', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await direct(a, b);
    const poll = await sent(a, cid, { kind: 'poll', body: 'Q', poll: { options: ['x', 'y'] } });
    expect((await call('PUT', `/v1/messages/${poll.id}/vote`, c, { options: [0] })).status).toBe(404);
    await call('POST', '/v1/blocks', b, { userId: a.id });
    expect((await call('PUT', `/v1/messages/${poll.id}/vote`, b, { options: [0] })).status).toBe(403);
  });
});

describe('starred messages', () => {
  it('stars privately, lists newest first across chats or for one chat, and drops deleted ones', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const one = await sent(b, cid, { body: 'address: 12 MG Road' });
    const two = await sent(b, cid, { body: 'gate code 4521' });
    expect((await call('PUT', `/v1/messages/${one.id}/star`, a, { starred: true })).body).toEqual({ messageId: one.id, starred: true });
    await call('PUT', `/v1/messages/${two.id}/star`, a, { starred: true });
    await call('PUT', `/v1/messages/${two.id}/star`, a, { starred: true }); // twice is fine

    let list = await call('GET', '/v1/messages/starred', a);
    expect(list.status).toBe(200);
    expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([two.id, one.id]);
    expect(list.body.messages[0].starredAt).toBeTruthy();
    expect((await call('GET', `/v1/messages/starred?conversationId=${cid}&limit=1`, a)).body.nextCursor).toBeTruthy();
    // Nobody else sees a's stars.
    expect((await call('GET', '/v1/messages/starred', b)).body.messages).toEqual([]);

    await call('DELETE', `/v1/messages/${two.id}`, b);
    list = await call('GET', '/v1/messages/starred', a);
    expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([one.id]);
    await call('PUT', `/v1/messages/${one.id}/star`, a, { starred: false });
    expect((await call('GET', '/v1/messages/starred', a)).body.messages).toEqual([]);

    const outsider = await user();
    expect((await call('PUT', `/v1/messages/${one.id}/star`, outsider, { starred: true })).status).toBe(404);
  });
});

describe('disappearing messages', () => {
  it('turns on for new messages only, tells everyone, and removes them for everyone when the time is up', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const before = await sent(a, cid, { body: 'kept' });
    expect(before.expiresAt).toBeNull();

    const on = await call('PUT', `/v1/conversations/${cid}/disappearing`, b, { seconds: 86400 });
    expect(on.status).toBe(200);
    expect(on.body.disappearSeconds).toBe(86400);
    const notice = (await call('GET', `/v1/conversations/${cid}/messages`, a)).body.messages.at(-1);
    expect(notice).toMatchObject({ kind: 'system', senderId: b.id, system: { type: 'disappearing_changed', seconds: 86400 } });
    expect((await call('PUT', `/v1/conversations/${cid}/disappearing`, b, { seconds: 3600 })).status).toBe(400);

    const gone = await sent(a, cid, { body: 'vanishes' });
    const left = new Date(gone.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(86000 * 1000);
    expect(left).toBeLessThanOrEqual(86400 * 1000);

    // Time passes.
    await pool.query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [gone.id]);
    expect(await ctx.app.get(MessagingService).sweepExpired()).toBe(1);
    const after = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages;
    expect(after.find((m: { id: string }) => m.id === gone.id)).toMatchObject({ body: null, deletedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(after.find((m: { id: string }) => m.id === before.id).body).toBe('kept');
    expect(await ctx.app.get(MessagingService).sweepExpired()).toBe(0);

    const off = await call('PUT', `/v1/conversations/${cid}/disappearing`, a, { seconds: null });
    expect(off.body.disappearSeconds).toBeNull();
    expect((await sent(a, cid, { body: 'stays' })).expiresAt).toBeNull();
  });

  it('follows the group’s "who can edit info" setting', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await group(a, [b], { infoPolicy: 'admins' });
    expect((await call('PUT', `/v1/conversations/${cid}/disappearing`, b, { seconds: 604800 })).status).toBe(403);
    expect((await call('PUT', `/v1/conversations/${cid}/disappearing`, a, { seconds: 604800 })).status).toBe(200);
    expect((await call('PUT', `/v1/conversations/${cid}/disappearing`, await user(), { seconds: null })).status).toBe(404);
  });
});

describe('view once', () => {
  it('lets each other person open it once, tells the sender, and closes every other way in', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await group(a, [b, c]);
    const mediaId = await photo(a);
    const m = await sent(a, cid, { kind: 'image', mediaId, viewOnce: true });
    expect(m).toMatchObject({ viewOnce: true, openedBy: [] });

    // The normal download is closed to everyone but the sender.
    expect((await call('GET', `/v1/media/${mediaId}`, b)).status).toBe(404);
    expect((await call('GET', `/v1/media/${mediaId}`, a)).status).toBe(200);

    const opened = await call('POST', `/v1/messages/${m.id}/open`, b);
    expect(opened.status).toBe(200);
    expect(opened.body.expiresIn).toBe(60);
    const file = await fetch(opened.body.url);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await call('POST', `/v1/messages/${m.id}/open`, b)).body.error.code).toBe('already_opened');
    expect((await call('POST', `/v1/messages/${m.id}/open`, a)).body.error.code).toBe('own_view_once');
    expect((await call('POST', `/v1/messages/${m.id}/open`, c)).status).toBe(200);

    const seen = (await call('GET', `/v1/conversations/${cid}/messages`, a)).body.messages.find((x: { id: string }) => x.id === m.id);
    expect(seen.openedBy).toEqual([b.id, c.id]);
    expect((await call('POST', `/v1/messages/${m.id}/forward`, b, { conversationIds: [cid], clientId: clientId() })).status).toBe(409);
  });

  it('is only for photos and videos', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    expect((await send(a, cid, { body: 'secret', viewOnce: true })).status).toBe(400);
    const text = await sent(a, cid, { body: 'plain' });
    expect((await call('POST', `/v1/messages/${text.id}/open`, b)).body.error.code).toBe('not_view_once');
  });
});

describe('location and contacts', () => {
  it('shares a place, and a live location that only the sharer moves and that ends', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const place = await sent(a, cid, { kind: 'location', location: { lat: 23.1205, lng: 72.0396, label: 'Hotel New Janpath, Viramgam' } });
    expect(place).toMatchObject({ kind: 'location', body: '', location: { lat: 23.1205, lng: 72.0396, label: 'Hotel New Janpath, Viramgam', liveUntil: null } });
    expect((await call('PUT', `/v1/messages/${place.id}/location`, a, { lat: 1, lng: 1 })).body.error.code).toBe('live_ended');

    const live = await sent(a, cid, { kind: 'location', location: { lat: 23, lng: 72, liveMinutes: 15 } });
    const until = new Date(live.location.liveUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(14 * 60_000);
    const moved = await call('PUT', `/v1/messages/${live.id}/location`, a, { lat: 23.01, lng: 72.02 });
    expect(moved.status).toBe(200);
    expect(moved.body.location).toMatchObject({ lat: 23.01, lng: 72.02 });
    expect(moved.body.changeSeq).toBeGreaterThan(live.changeSeq);
    expect((await call('PUT', `/v1/messages/${live.id}/location`, b, { lat: 0, lng: 0 })).status).toBe(403);
    const stopped = await call('POST', `/v1/messages/${live.id}/location/stop`, a);
    expect(new Date(stopped.body.location.liveUntil).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await call('PUT', `/v1/messages/${live.id}/location`, a, { lat: 1, lng: 1 })).body.error.code).toBe('live_ended');

    // A forwarded location is a plain place, not a live share.
    const fwd = await call('POST', `/v1/messages/${moved.body.id}/forward`, b, { conversationIds: [cid], clientId: clientId() });
    expect(fwd.status).toBe(201);
    expect(fwd.body.messages[0].location).toMatchObject({ lat: 23.01, lng: 72.02, liveUntil: null });

    for (const bad of [
      { kind: 'location', location: { lat: 91, lng: 0 } },
      { kind: 'location', location: { lat: 0, lng: 0, liveMinutes: 30 } },
      { kind: 'location' },
      { kind: 'location', body: 'hi', location: { lat: 0, lng: 0 } },
    ]) {
      expect([bad, (await send(a, cid, bad)).status]).toEqual([bad, 400]);
    }
    // Deleting clears the place.
    await call('DELETE', `/v1/messages/${place.id}`, a);
    const after = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages.find((m: { id: string }) => m.id === place.id);
    expect(after.location).toBeNull();
  });

  it('shares a SuperApp contact card, never someone blocked or gone', async () => {
    const [a, b, friend, blocked] = [await user(), await user(), await user(), await user()];
    const cid = await direct(a, b);
    const card = await sent(a, cid, { kind: 'contact', contactUserId: friend.id });
    expect(card.contact).toEqual({ userId: friend.id, username: expect.any(String), displayName: expect.any(String) });
    await call('POST', '/v1/blocks', blocked, { userId: a.id });
    expect((await send(a, cid, { kind: 'contact', contactUserId: blocked.id })).status).toBe(404);
    expect((await send(a, cid, { kind: 'contact', contactUserId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
    expect((await send(a, cid, { kind: 'contact' })).status).toBe(400);
    expect((await send(a, cid, { kind: 'text', body: 'x', contactUserId: friend.id })).status).toBe(400);
  });
});

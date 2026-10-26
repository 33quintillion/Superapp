import { Pool } from 'pg';
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

const user = () => registerUser(ctx.app, 'm');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function direct(a: TestUser, b: TestUser): Promise<string> {
  const r = await call('POST', '/v1/conversations/direct', a, { userId: b.id });
  expect(r.status).toBe(200);
  return r.body.id;
}

async function send(u: TestUser, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await call('POST', `/v1/conversations/${conversationId}/messages`, u, { clientId: clientId(), body, ...extra });
  if (r.status !== 201) throw new Error(`send failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.message;
}

describe('direct conversations', () => {
  it('has exactly one conversation per pair, whoever opens it', async () => {
    const [a, b] = [await user(), await user()];
    const id1 = await direct(a, b);
    const id2 = await direct(b, a);
    expect(id2).toBe(id1);
    const conv = (await call('GET', `/v1/conversations/${id1}`, a)).body;
    expect(conv).toMatchObject({ kind: 'direct', peerId: b.id, unreadCount: 0, lastMessage: null });
    expect(conv.members.map((m: { userId: string }) => m.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses self, unknown and blocked users with the same answers as profile lookup', async () => {
    const [a, b] = [await user(), await user()];
    expect((await call('POST', '/v1/conversations/direct', a, { userId: a.id })).status).toBe(400);
    expect((await call('POST', '/v1/conversations/direct', a, { userId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
    await call('POST', '/v1/blocks', b, { userId: a.id });
    expect((await call('POST', '/v1/conversations/direct', a, { userId: b.id })).status).toBe(404);
  });

  it('keeps outsiders out of every conversation endpoint', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'private');
    for (const [method, url, body] of [
      ['GET', `/v1/conversations/${cid}`],
      ['GET', `/v1/conversations/${cid}/messages`],
      ['GET', `/v1/conversations/${cid}/changes`],
      ['GET', `/v1/conversations/${cid}/pins`],
      ['POST', `/v1/conversations/${cid}/messages`, { clientId: clientId(), body: 'hi' }],
      ['POST', `/v1/conversations/${cid}/receipts`, { kind: 'read', seq: 1 }],
      ['PATCH', `/v1/conversations/${cid}`, { archived: true }],
      ['PUT', `/v1/messages/${m.id}/reaction`, { emoji: '👍' }],
      ['PUT', `/v1/messages/${m.id}/pin`, { pinned: true }],
      ['POST', `/v1/messages/${m.id}/hide`],
      ['PATCH', `/v1/messages/${m.id}`, { body: 'x' }],
      ['DELETE', `/v1/messages/${m.id}`],
      ['POST', `/v1/messages/${m.id}/forward`, { conversationIds: [cid], clientId: clientId() }],
    ] as [string, string, unknown?][]) {
      expect([method, url, (await call(method, url, c, body)).status]).toEqual([method, url, 404]);
    }
    const search = await call('GET', '/v1/messages/search?q=private', c);
    expect(search.body.results).toEqual([]);
    expect((await call('GET', '/v1/conversations', c)).body.conversations).toEqual([]);
  });

  it('lists conversations by latest activity with unread counts, and supports archive and mute', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const ab = await direct(a, b);
    const ac = await direct(a, c);
    await send(b, ab, 'one');
    await send(b, ab, 'two');
    await send(c, ac, 'three');
    let list = (await call('GET', '/v1/conversations', a)).body.conversations;
    expect(list.map((x: { id: string }) => x.id)).toEqual([ac, ab]);
    expect(list.map((x: { unreadCount: number }) => x.unreadCount)).toEqual([1, 2]);
    expect(list[0].lastMessage.body).toBe('three');

    const page1 = (await call('GET', '/v1/conversations?limit=1', a)).body;
    expect(page1.conversations.map((x: { id: string }) => x.id)).toEqual([ac]);
    const page2 = (await call('GET', `/v1/conversations?limit=1&cursor=${page1.nextCursor}`, a)).body;
    expect(page2.conversations.map((x: { id: string }) => x.id)).toEqual([ab]);
    expect(page2.nextCursor).toBeNull();

    const until = new Date(Date.now() + 3600_000).toISOString();
    const upd = await call('PATCH', `/v1/conversations/${ab}`, a, { archived: true, mutedUntil: until });
    expect(upd.body).toMatchObject({ archived: true });
    expect(new Date(upd.body.mutedUntil).toISOString()).toBe(until);
    list = (await call('GET', '/v1/conversations', a)).body.conversations;
    expect(list.map((x: { id: string }) => x.id)).toEqual([ac]);
    expect((await call('GET', '/v1/conversations?archived=true', a)).body.conversations.map((x: { id: string }) => x.id)).toEqual([ab]);
    // Archiving is per person.
    expect((await call('GET', '/v1/conversations', b)).body.conversations.map((x: { id: string }) => x.id)).toEqual([ab]);
  });
});

describe('sending', () => {
  it('stores messages in order and both people see the same history', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m1 = await send(a, cid, 'hello');
    const m2 = await send(b, cid, 'hi there');
    expect(m2.seq).toBeGreaterThan(m1.seq);
    for (const u of [a, b]) {
      const h = (await call('GET', `/v1/conversations/${cid}/messages`, u)).body;
      expect(h.messages.map((m: { body: string }) => m.body)).toEqual(['hello', 'hi there']);
      expect(h.hasMore).toBe(false);
    }
  });

  it('treats a retry with the same clientId as the same message', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const id = clientId();
    const first = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: id, body: 'once' });
    const again = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: id, body: 'once' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, message: { id: first.body.message.id } });
    // Concurrent retries (a flaky network firing several at once) still make one message.
    const id2 = clientId();
    const burst = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: id2, body: 'burst' })));
    expect(new Set(burst.map((r) => r.body.message.id)).size).toBe(1);
    expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
    const h = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages;
    expect(h.map((m: { body: string }) => m.body)).toEqual(['once', 'burst']);
  });

  it('gives concurrent sends unique, gap-free sequence numbers', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const sent = await Promise.all(Array.from({ length: 30 }, (_, i) => send(i % 2 ? a : b, cid, `n${i}`)));
    const seqs = sent.map((m) => m.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const h = (await call('GET', `/v1/conversations/${cid}/messages?limit=100`, a)).body.messages;
    expect(h.map((m: { seq: number }) => m.seq)).toEqual(seqs);
  });

  it('validates content, replies and mentions', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await direct(a, b);
    const other = await direct(a, c);
    const post = (body: unknown) => call('POST', `/v1/conversations/${cid}/messages`, a, body);
    expect((await post({ clientId: clientId(), body: '   ' })).status).toBe(400);
    expect((await post({ clientId: 'short', body: 'x' })).status).toBe(400);
    expect((await post({ clientId: clientId(), body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ clientId: clientId(), kind: 'image', body: '' })).status).toBe(400);
    expect((await post({ clientId: clientId(), body: 'x', unknown: 1 })).status).toBe(400);

    const root = await send(b, cid, 'question?');
    const elsewhere = await send(a, other, 'elsewhere');
    const reply = await send(a, cid, 'answer', { replyToId: root.id, mentions: [b.id] });
    expect(reply.replyTo).toMatchObject({ id: root.id, senderId: b.id, preview: 'question?', deleted: false });
    expect(reply.mentions).toEqual([b.id]);
    expect((await post({ clientId: clientId(), body: 'x', replyToId: elsewhere.id })).status).toBe(400);
    expect((await post({ clientId: clientId(), body: 'x', mentions: [c.id] })).status).toBe(400);
  });
});

describe('permissions', () => {
  it('stops messages in both directions after a block, and resumes after unblock', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'before');
    await call('POST', '/v1/blocks', b, { userId: a.id });
    for (const u of [a, b]) {
      const r = await call('POST', `/v1/conversations/${cid}/messages`, u, { clientId: clientId(), body: 'after' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('cannot_message');
    }
    expect((await call('PUT', `/v1/messages/${m.id}/reaction`, a, { emoji: '👍' })).status).toBe(403);
    // History stays readable.
    expect((await call('GET', `/v1/conversations/${cid}/messages`, a)).body.messages).toHaveLength(1);
    await call('DELETE', `/v1/blocks/${a.id}`, b);
    expect((await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'again' })).status).toBe(201);
  });

  it('honours "who can message me" until the recipient replies', async () => {
    const [a, b] = [await user(), await user()];
    await call('PATCH', '/v1/me/privacy', b, { whoCanMessage: 'nobody' });
    const cid = await direct(a, b);
    const r = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'hi stranger' });
    expect(r.status).toBe(403);
    await send(b, cid, 'actually, hello');
    expect((await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'hi!' })).status).toBe(201);

    const c = await user();
    await call('PATCH', '/v1/me/privacy', c, { whoCanMessage: 'contacts' });
    const ac = await direct(a, c);
    expect((await call('POST', `/v1/conversations/${ac}/messages`, a, { clientId: clientId(), body: 'hi' })).status).toBe(403);
  });
});

describe('editing, deleting, reactions and pins', () => {
  it('lets only the sender edit, within the edit window', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'teh typo');
    const e = await call('PATCH', `/v1/messages/${m.id}`, a, { body: 'the typo' });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ body: 'the typo', seq: m.seq });
    expect(e.body.editedAt).not.toBeNull();
    expect(e.body.changeSeq).toBeGreaterThan(m.changeSeq);
    expect((await call('PATCH', `/v1/messages/${m.id}`, b, { body: 'hijack' })).status).toBe(403);
    expect((await call('PATCH', `/v1/messages/${m.id}`, a, { body: ' ' })).status).toBe(400);
    await pool.query(`UPDATE messages SET created_at = now() - interval '16 minutes' WHERE id = $1`, [m.id]);
    const late = await call('PATCH', `/v1/messages/${m.id}`, a, { body: 'too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('edit_window_passed');
  });

  it('deletes for everyone (sender only), clearing content, reactions and pins', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'oops');
    const reply = await send(b, cid, 'what?', { replyToId: m.id });
    await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: '😮' });
    await call('PUT', `/v1/messages/${m.id}/pin`, b, { pinned: true });
    expect((await call('DELETE', `/v1/messages/${m.id}`, b)).status).toBe(403);
    const d = await call('DELETE', `/v1/messages/${m.id}`, a);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ body: null, reactions: [], pinnedAt: null, mentions: [] });
    expect(d.body.deletedAt).not.toBeNull();
    // Deleting twice is harmless and does not move the counter.
    const again = await call('DELETE', `/v1/messages/${m.id}`, a);
    expect(again.body.changeSeq).toBe(d.body.changeSeq);
    const seen = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages;
    expect(seen.find((x: { id: string }) => x.id === m.id)).toMatchObject({ body: null });
    expect(seen.find((x: { id: string }) => x.id === reply.id).replyTo).toMatchObject({ deleted: true, preview: '' });
    const { rows } = await pool.query('SELECT body FROM messages WHERE id = $1', [m.id]);
    expect(rows[0].body).toBe('');
    // Can't edit or react to it any more.
    expect((await call('PATCH', `/v1/messages/${m.id}`, a, { body: 'back' })).status).toBe(409);
    expect((await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: '👍' })).status).toBe(409);
  });

  it('refuses delete-for-everyone after 48 hours', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'old news');
    await pool.query(`UPDATE messages SET created_at = now() - interval '49 hours' WHERE id = $1`, [m.id]);
    expect((await call('DELETE', `/v1/messages/${m.id}`, a)).body.error.code).toBe('delete_window_passed');
  });

  it('hides a message for one person only', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'hide me');
    await send(a, cid, 'keep me');
    expect((await call('POST', `/v1/messages/${m.id}/hide`, b)).status).toBe(204);
    expect((await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages.map((x: { body: string }) => x.body)).toEqual(['keep me']);
    expect((await call('GET', `/v1/conversations/${cid}/messages`, a)).body.messages).toHaveLength(2);
    const ch = (await call('GET', `/v1/conversations/${cid}/changes?since=0`, b)).body.changes;
    expect(ch.find((x: { id: string }) => x.id === m.id)).toEqual({ id: m.id, conversationId: cid, seq: m.seq, changeSeq: expect.any(Number), hidden: true });
    expect((await call('GET', '/v1/messages/search?q=hide', b)).body.results).toEqual([]);
  });

  it('keeps one reaction per person, which can be changed or removed', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'react to me');
    await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: '👍' });
    await call('PUT', `/v1/messages/${m.id}/reaction`, a, { emoji: '❤️' });
    let r = await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: '👍🏽' });
    expect(r.body.reactions).toEqual([
      { userId: a.id, emoji: '❤️' },
      { userId: b.id, emoji: '👍🏽' },
    ]);
    r = await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: null });
    expect(r.body.reactions).toEqual([{ userId: a.id, emoji: '❤️' }]);
    for (const bad of ['abc', '', '👍 ok', '<b>']) {
      expect((await call('PUT', `/v1/messages/${m.id}/reaction`, b, { emoji: bad })).status).toBe(400);
    }
  });

  it('pins and unpins, with a limit per chat', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const msgs = [];
    for (let i = 0; i < 11; i++) msgs.push(await send(a, cid, `pin ${i}`));
    for (let i = 0; i < 10; i++) expect((await call('PUT', `/v1/messages/${msgs[i].id}/pin`, b, { pinned: true })).status).toBe(200);
    const over = await call('PUT', `/v1/messages/${msgs[10].id}/pin`, a, { pinned: true });
    expect(over.body.error.code).toBe('too_many_pins');
    const pins = (await call('GET', `/v1/conversations/${cid}/pins`, a)).body;
    expect(pins).toHaveLength(10);
    expect(pins[0]).toMatchObject({ pinnedBy: b.id });
    await call('PUT', `/v1/messages/${msgs[0].id}/pin`, a, { pinned: false });
    expect((await call('GET', `/v1/conversations/${cid}/pins`, a)).body).toHaveLength(9);
  });
});

describe('forwarding and search', () => {
  it('forwards into chats the user belongs to, marked as forwarded', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const ab = await direct(a, b);
    const bc = await direct(b, c);
    const cd = await direct(c, d);
    const m = await send(a, ab, 'pass it on');
    const f = await call('POST', `/v1/messages/${m.id}/forward`, b, { conversationIds: [bc], clientId: clientId() });
    expect(f.status).toBe(201);
    expect(f.body.messages[0]).toMatchObject({ conversationId: bc, senderId: b.id, body: 'pass it on', forwarded: true });
    expect((await call('GET', `/v1/conversations/${bc}/messages`, c)).body.messages[0].forwarded).toBe(true);
    // Not into a chat you're not in.
    expect((await call('POST', `/v1/messages/${m.id}/forward`, b, { conversationIds: [cd], clientId: clientId() })).status).toBe(404);
  });

  it('finds words by prefix only in the user’s own chats, skipping deleted messages', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const ab = await direct(a, b);
    const bc = await direct(b, c);
    const tag = `zebra${Date.now()}`;
    await send(a, ab, `the ${tag} crossing`);
    const gone = await send(a, ab, `${tag} deleted`);
    await call('DELETE', `/v1/messages/${gone.id}`, a);
    await send(c, bc, `${tag} from c`);
    await send(a, ab, 'Ünïcödé straße');

    const forA = (await call('GET', `/v1/messages/search?q=${tag.slice(0, 8)}`, a)).body.results;
    expect(forA.map((m: { body: string }) => m.body)).toEqual([`the ${tag} crossing`]);
    const forB = (await call('GET', `/v1/messages/search?q=${tag}`, b)).body.results;
    expect(forB.map((m: { body: string }) => m.body).sort()).toEqual([`${tag} from c`, `the ${tag} crossing`].sort());
    const scoped = (await call('GET', `/v1/messages/search?q=${tag}&conversationId=${bc}`, b)).body.results;
    expect(scoped).toHaveLength(1);
    const paged = (await call('GET', `/v1/messages/search?q=${tag}&limit=1`, b)).body;
    expect(paged.results).toHaveLength(1);
    const next = (await call('GET', `/v1/messages/search?q=${tag}&limit=1&cursor=${paged.nextCursor}`, b)).body;
    expect(next.results[0].id).not.toBe(paged.results[0].id);
    expect((await call('GET', `/v1/messages/search?q=${encodeURIComponent('straß')}`, b)).body.results).toHaveLength(1);
    // Query syntax can't be injected.
    expect((await call('GET', `/v1/messages/search?q=${encodeURIComponent("a:* | !b & ('")}`, b)).status).toBe(200);
  });
});

describe('history and sync', () => {
  it('pages back through history and forward from a known point', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    for (let i = 1; i <= 25; i++) await send(a, cid, `m${i}`);
    const p1 = (await call('GET', `/v1/conversations/${cid}/messages?limit=10`, b)).body;
    expect(p1.messages.map((m: { body: string }) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 16}`));
    expect(p1.hasMore).toBe(true);
    const p2 = (await call('GET', `/v1/conversations/${cid}/messages?limit=10&before=${p1.messages[0].seq}`, b)).body;
    expect(p2.messages[0].body).toBe('m6');
    const p3 = (await call('GET', `/v1/conversations/${cid}/messages?limit=10&before=${p2.messages[0].seq}`, b)).body;
    expect(p3.messages.map((m: { body: string }) => m.body)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(p3.hasMore).toBe(false);
    const fwd = (await call('GET', `/v1/conversations/${cid}/messages?after=20&limit=3`, b)).body;
    expect(fwd.messages.map((m: { body: string }) => m.body)).toEqual(['m21', 'm22', 'm23']);
    expect(fwd.hasMore).toBe(true);
    expect((await call('GET', `/v1/conversations/${cid}/messages?after=1&before=3`, b)).status).toBe(400);
  });

  it('replays every change since a point, so a device that was offline catches up', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m1 = await send(a, cid, 'first');
    const since = (await call('GET', `/v1/conversations/${cid}/changes?since=0`, b)).body.nextSince;
    expect(since).toBe(m1.changeSeq);
    // While b is "offline": a new message, an edit and a reaction to the old one.
    const m2 = await send(a, cid, 'second');
    await call('PATCH', `/v1/messages/${m1.id}`, a, { body: 'first (edited)' });
    await call('PUT', `/v1/messages/${m2.id}/reaction`, a, { emoji: '🎉' });
    const ch = (await call('GET', `/v1/conversations/${cid}/changes?since=${since}`, b)).body;
    expect(ch.changes.map((c: { id: string; body: string }) => [c.id, c.body])).toEqual([
      [m1.id, 'first (edited)'],
      [m2.id, 'second'],
    ]);
    expect(ch.hasMore).toBe(false);
    const head = (await call('GET', `/v1/conversations/${cid}`, b)).body.lastSeq;
    expect(ch.nextSince).toBe(head);
    expect((await call('GET', `/v1/conversations/${cid}/changes?since=${ch.nextSince}`, b)).body.changes).toEqual([]);
  });

  it('pages the change feed without skipping anything', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    for (let i = 0; i < 7; i++) await send(a, cid, `c${i}`);
    const seen: string[] = [];
    let since = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = (await call('GET', `/v1/conversations/${cid}/changes?since=${since}&limit=3`, b)).body;
      seen.push(...page.changes.map((c: { body: string }) => c.body));
      since = page.nextSince;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `c${i}`));
  });
});

describe('receipts', () => {
  it('moves delivered and read positions forward only, and clears unread', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    await send(a, cid, 'one');
    const m2 = await send(a, cid, 'two');
    expect((await call('GET', `/v1/conversations/${cid}`, b)).body.unreadCount).toBe(2);
    const d = await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'delivered', seq: m2.seq });
    expect(d.body).toMatchObject({ lastDeliveredSeq: m2.seq, lastReadSeq: 0 });
    const r = await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'read', seq: 1 });
    expect(r.body).toMatchObject({ lastDeliveredSeq: m2.seq, lastReadSeq: 1 });
    expect((await call('GET', `/v1/conversations/${cid}`, b)).body.unreadCount).toBe(1);
    // Going backwards is ignored; going past the end is clamped.
    expect((await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'delivered', seq: 0 })).body.lastDeliveredSeq).toBe(m2.seq);
    expect((await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'read', seq: 999 })).body.lastReadSeq).toBe(m2.seq);
    expect((await call('GET', `/v1/conversations/${cid}`, b)).body.unreadCount).toBe(0);
    const forA = (await call('GET', `/v1/conversations/${cid}`, a)).body.members.find((m: { userId: string }) => m.userId === b.id);
    expect(forA).toMatchObject({ lastDeliveredSeq: m2.seq, lastReadSeq: m2.seq });
  });

  it('hides read positions both ways when either person turns read receipts off', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'seen?');
    await send(b, cid, 'yes');
    await call('POST', `/v1/conversations/${cid}/receipts`, b, { kind: 'read', seq: m.seq });
    await call('POST', `/v1/conversations/${cid}/receipts`, a, { kind: 'read', seq: m.seq + 1 });
    await call('PATCH', '/v1/me/privacy', b, { showReadReceipts: false });
    const forA = (await call('GET', `/v1/conversations/${cid}`, a)).body.members;
    const forB = (await call('GET', `/v1/conversations/${cid}`, b)).body.members;
    expect(forA.find((x: { userId: string }) => x.userId === b.id).lastReadSeq).toBeNull();
    expect(forB.find((x: { userId: string }) => x.userId === a.id).lastReadSeq).toBeNull();
    // Delivery ticks and your own position stay visible (b's own reply counts as read).
    expect(forA.find((x: { userId: string }) => x.userId === b.id).lastDeliveredSeq).toBe(m.seq + 1);
    expect(forB.find((x: { userId: string }) => x.userId === b.id).lastReadSeq).toBe(m.seq + 1);
  });
});

describe('account deletion and export', () => {
  it('exports sent messages, and deletion wipes them for the other person', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const m = await send(a, cid, 'my words');
    const theirs = await send(b, cid, 'their words');
    await call('PUT', `/v1/messages/${theirs.id}/reaction`, a, { emoji: '👍' });
    const exp = (await call('GET', '/v1/me/export', a)).body;
    expect(exp.messagesSent.map((x: { body: string }) => x.body)).toEqual(['my words']);

    expect((await call('DELETE', '/v1/me', a, { password: a.password })).status).toBe(204);
    const seen = (await call('GET', `/v1/conversations/${cid}/messages`, b)).body.messages;
    expect(seen.find((x: { id: string }) => x.id === m.id)).toMatchObject({ body: null });
    expect(seen.find((x: { id: string }) => x.id === theirs.id)).toMatchObject({ body: 'their words', reactions: [] });
    const { rows } = await pool.query('SELECT body FROM messages WHERE sender_id = $1', [a.id]);
    expect(rows.every((r) => r.body === '')).toBe(true);
    // b's other devices learn about it from the change feed.
    const ch = (await call('GET', `/v1/conversations/${cid}/changes?since=${theirs.changeSeq}`, b)).body.changes;
    expect(ch.map((c: { id: string }) => c.id).sort()).toEqual([m.id, theirs.id].sort());
    expect((await call('POST', `/v1/conversations/${cid}/messages`, b, { clientId: clientId(), body: 'hello?' })).status).toBe(403);
  });
});

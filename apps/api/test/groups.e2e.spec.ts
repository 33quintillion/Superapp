import { RealtimeBus, RealtimeEvent } from '../src/realtime/realtime-bus.service';
import { clientId, registerUser, req, startApp, TestContext, TestUser } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => {
  await ctx.close();
});

const user = () => registerUser(ctx.app, 'g');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function group(owner: TestUser, members: TestUser[], extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/v1/conversations/groups', owner, { title: 'Hiking club', memberIds: members.map((m) => m.id), ...extra });
  if (r.status !== 201) throw new Error(`group create failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function send(u: TestUser, cid: string, body: string) {
  return call('POST', `/v1/conversations/${cid}/messages`, u, { clientId: clientId(), body });
}

async function history(u: TestUser, cid: string) {
  const r = await call('GET', `/v1/conversations/${cid}/messages`, u);
  expect(r.status).toBe(200);
  return r.body.messages as { kind: string; body: string | null; system: Record<string, unknown> | null; senderId: string }[];
}

const role = (conv: { members: { userId: string; role: string }[] }, u: TestUser) => conv.members.find((m) => m.userId === u.id)?.role;

describe('group chats', () => {
  it('creates a group with the creator as owner and a "created" notice everyone sees', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const g = await group(a, [b, c], { description: 'Weekend walks' });
    expect(g).toMatchObject({ kind: 'group', title: 'Hiking club', peerId: null, group: { description: 'Weekend walks', myRole: 'owner', sendPolicy: 'everyone', addPolicy: 'admins', infoPolicy: 'admins' } });
    expect(role(g, a)).toBe('owner');
    expect(role(g, b)).toBe('member');
    const hb = await history(b, g.id);
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ kind: 'system', body: '', senderId: a.id, system: { type: 'group_created', title: 'Hiking club' } });
    // Notices don't count as unread, and can't be edited, reacted to, pinned or forwarded.
    expect((await call('GET', `/v1/conversations/${g.id}`, b)).body.unreadCount).toBe(0);
    const sysId = (await call('GET', `/v1/conversations/${g.id}/messages`, a)).body.messages[0].id;
    expect((await call('PATCH', `/v1/messages/${sysId}`, a, { body: 'x' })).body.error.code).toBe('system_message');
    expect((await call('PUT', `/v1/messages/${sysId}/reaction`, b, { emoji: '👍' })).body.error.code).toBe('system_message');
    expect((await call('PUT', `/v1/messages/${sysId}/pin`, a, { pinned: true })).body.error.code).toBe('system_message');
    expect((await call('DELETE', `/v1/messages/${sysId}`, a)).body.error.code).toBe('system_message');

    expect((await send(b, g.id, 'hi all')).status).toBe(201);
    expect((await call('GET', `/v1/conversations/${g.id}`, c)).body.unreadCount).toBe(1);
  });

  it('validates the title and refuses unknown people', async () => {
    const a = await user();
    expect((await call('POST', '/v1/conversations/groups', a, { title: '  ', memberIds: [] })).status).toBe(400);
    const r = await call('POST', '/v1/conversations/groups', a, { title: 'x', memberIds: ['00000000-0000-4000-8000-000000000009'] });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'cannot_add', details: { userIds: ['00000000-0000-4000-8000-000000000009'] } });
  });

  it('respects who can add me to groups, and blocks', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    await call('PATCH', '/v1/me/privacy', b, { whoCanAddToGroups: 'nobody' });
    await call('PATCH', '/v1/me/privacy', c, { whoCanAddToGroups: 'following' });
    await call('POST', '/v1/blocks', d, { userId: a.id });
    const r = await call('POST', '/v1/conversations/groups', a, { title: 'x', memberIds: [b.id, c.id, d.id] });
    expect(r.status).toBe(403);
    expect(r.body.error.details.userIds.sort()).toEqual([b.id, c.id, d.id].sort());
    // "following" lets in people c follows.
    await call('POST', `/v1/users/${a.id}/follow`, c);
    expect((await call('POST', '/v1/conversations/groups', a, { title: 'x', memberIds: [c.id] })).status).toBe(201);
  });

  it('shows people added later only what was sent after they joined', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const g = await group(a, [b]);
    await send(a, g.id, 'before c joined');
    const old = (await call('GET', `/v1/conversations/${g.id}/messages`, a)).body.messages.at(-1);
    const added = await call('POST', `/v1/conversations/${g.id}/members`, a, { userIds: [c.id] });
    expect(added.status).toBe(200);
    expect(role(added.body, c)).toBe('member');
    await send(b, g.id, 'welcome c');

    const hc = await history(c, g.id);
    expect(hc.map((m) => m.system?.type ?? m.body)).toEqual(['members_added', 'welcome c']);
    expect(hc[0].system).toMatchObject({ userIds: [c.id] });
    const changes = (await call('GET', `/v1/conversations/${g.id}/changes?since=0`, c)).body.changes;
    expect(changes.map((m: { body: string }) => m.body)).not.toContain('before c joined');
    expect((await call('GET', `/v1/messages/search?q=before`, c)).body.results).toEqual([]);
    expect((await call('GET', `/v1/messages/search?q=before`, b)).body.results).toHaveLength(1);
    // Earlier messages can't be reached by id either.
    expect((await call('PUT', `/v1/messages/${old.id}/reaction`, c, { emoji: '👍' })).status).toBe(404);
    expect((await call('POST', `/v1/messages/${old.id}/forward`, c, { conversationIds: [g.id], clientId: clientId() })).status).toBe(404);
    const conv = (await call('GET', `/v1/conversations/${g.id}`, c)).body;
    expect(conv.unreadCount).toBe(1);
    expect(conv.lastMessage.body).toBe('welcome c');
  });

  it('lets only admins add people unless the group allows everyone', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const g = await group(a, [b]);
    expect((await call('POST', `/v1/conversations/${g.id}/members`, b, { userIds: [c.id] })).status).toBe(403);
    expect((await call('PATCH', `/v1/conversations/${g.id}/group`, b, { addPolicy: 'everyone' })).status).toBe(403);
    expect((await call('PATCH', `/v1/conversations/${g.id}/group`, a, { addPolicy: 'everyone' })).body.group.addPolicy).toBe('everyone');
    expect((await call('POST', `/v1/conversations/${g.id}/members`, b, { userIds: [c.id] })).status).toBe(200);
    // Outsiders get a 404, never a hint the group exists.
    expect((await call('POST', `/v1/conversations/${g.id}/members`, d, { userIds: [d.id] })).status).toBe(404);
    expect((await call('PATCH', `/v1/conversations/${g.id}/group`, d, { title: 'mine' })).status).toBe(404);
  });

  it('enforces admins-only messaging and info editing', async () => {
    const [a, b] = [await user(), await user()];
    const g = await group(a, [b]);
    expect((await call('PATCH', `/v1/conversations/${g.id}/group`, b, { title: 'New name' })).status).toBe(403);
    await call('PATCH', `/v1/conversations/${g.id}/group`, a, { sendPolicy: 'admins', infoPolicy: 'everyone' });
    const r = await send(b, g.id, 'can I talk?');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('admins_only');
    expect((await send(a, g.id, 'announcement')).status).toBe(201);
    const renamed = await call('PATCH', `/v1/conversations/${g.id}/group`, b, { title: 'New name' });
    expect(renamed.body.title).toBe('New name');
    const last = (await history(a, g.id)).at(-1)!;
    expect(last.system).toEqual({ type: 'group_updated', fields: ['title'], title: 'New name' });
    // Promoting b lets them send again.
    await call('PATCH', `/v1/conversations/${g.id}/members/${b.id}`, a, { role: 'admin' });
    expect((await send(b, g.id, 'now I can')).status).toBe(201);
  });

  it('applies the role hierarchy for promoting, demoting and removing', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const g = await group(a, [b, c, d]);
    const set = (actor: TestUser, target: TestUser, r: string) => call('PATCH', `/v1/conversations/${g.id}/members/${target.id}`, actor, { role: r });
    const remove = (actor: TestUser, target: TestUser) => call('DELETE', `/v1/conversations/${g.id}/members/${target.id}`, actor);

    expect((await set(c, d, 'admin')).status).toBe(403); // members can't promote
    expect((await set(a, b, 'admin')).status).toBe(200);
    expect((await set(b, c, 'admin')).status).toBe(200); // admins can promote
    expect((await set(b, c, 'member')).status).toBe(403); // only the owner demotes
    expect((await remove(b, c)).status).toBe(403); // admins can't remove admins
    expect((await remove(b, a)).status).toBe(403);
    expect((await set(b, b, 'owner')).status).toBe(400);
    expect((await remove(b, d)).status).toBe(204);
    expect((await call('GET', `/v1/conversations/${g.id}`, d)).status).toBe(404);
    expect((await send(d, g.id, 'still here?')).status).toBe(404);
    expect((await set(a, c, 'member')).status).toBe(200);

    // Handing over: a becomes admin, b owner.
    const handed = await set(a, b, 'owner');
    expect(role(handed.body, b)).toBe('owner');
    expect(role(handed.body, a)).toBe('admin');
    const types = (await history(a, g.id)).filter((m) => m.kind === 'system').map((m) => m.system!.type);
    expect(types).toEqual(['group_created', 'role_changed', 'role_changed', 'member_removed', 'role_changed', 'role_changed']);
  });

  it('passes ownership on when the owner leaves', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const g = await group(a, [b, c]);
    await call('PATCH', `/v1/conversations/${g.id}/members/${c.id}`, a, { role: 'admin' });
    expect((await call('DELETE', `/v1/conversations/${g.id}/members/${a.id}`, a)).status).toBe(204);
    const conv = (await call('GET', `/v1/conversations/${g.id}`, b)).body;
    expect(role(conv, c)).toBe('owner'); // the admin, not the longer-standing member
    expect(conv.members).toHaveLength(2);
    const tail = (await history(b, g.id)).slice(-2).map((m) => m.system);
    expect(tail).toEqual([{ type: 'member_left' }, { type: 'role_changed', userId: c.id, role: 'owner' }]);
    expect((await call('GET', '/v1/conversations', a)).body.conversations.map((x: { id: string }) => x.id)).not.toContain(g.id);
  });

  it('keeps a group working between people who blocked each other', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const g = await group(a, [b, c]);
    await call('POST', '/v1/blocks', b, { userId: c.id });
    expect((await send(c, g.id, 'hello group')).status).toBe(201);
    const msg = (await history(b, g.id)).at(-1)! as unknown as { id: string };
    expect((await call('PUT', `/v1/messages/${msg.id}/reaction`, b, { emoji: '👍' })).status).toBe(200);
    // ...but direct chats between them stay closed.
    expect((await call('POST', '/v1/conversations/direct', c, { userId: b.id })).status).toBe(404);
  });

  it('announces changes to members in real time and tells removed people', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const g = await group(a, [b]);
    const bus = ctx.app.get(RealtimeBus);
    const seen: [string[], RealtimeEvent][] = [];
    const spy = jest.spyOn(bus, 'publish').mockImplementation(async (ids, e) => {
      seen.push([[...ids], e]);
    });
    try {
      await call('POST', `/v1/conversations/${g.id}/members`, a, { userIds: [c.id] });
      const created = seen.find(([, e]) => e.type === 'message.created')!;
      expect(created[0].sort()).toEqual([a.id, b.id, c.id].sort());
      expect(created[1].data).toMatchObject({ kind: 'system', system: { type: 'members_added' } });
      expect(seen.some(([, e]) => e.type === 'conversation.changed')).toBe(true);
      seen.length = 0;
      await call('DELETE', `/v1/conversations/${g.id}/members/${c.id}`, a);
      expect(seen.find(([, e]) => e.type === 'message.created')![0].sort()).toEqual([a.id, b.id].sort());
      expect(seen).toContainEqual([[c.id], { type: 'conversation.removed', data: { id: g.id } }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('removes a deleted account from its groups and hands on ownership', async () => {
    const [a, b] = [await user(), await user()];
    const g = await group(a, [b]);
    expect((await call('DELETE', '/v1/me', a, { password: a.password })).status).toBe(204);
    const conv = (await call('GET', `/v1/conversations/${g.id}`, b)).body;
    expect(conv.members.map((m: { userId: string }) => m.userId)).toEqual([b.id]);
    expect(role(conv, b)).toBe('owner');
  });
});

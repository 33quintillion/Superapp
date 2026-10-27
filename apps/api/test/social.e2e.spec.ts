import { Pool } from 'pg';
import { StoriesService } from '../src/social/stories.service';
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

const user = () => registerUser(ctx.app, 's');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function image(u: TestUser) {
  const created = await call('POST', '/v1/media/uploads', u, { kind: 'image', contentType: 'image/png', byteSize: PNG.length, width: 1, height: 1 });
  const put = await fetch(created.body.upload.url, { method: 'PUT', headers: created.body.upload.headers, body: PNG });
  expect(put.status).toBe(200);
  expect((await call('POST', `/v1/media/${created.body.media.id}/complete`, u)).status).toBe(200);
  return created.body.media.id as string;
}

async function post(u: TestUser, body: Record<string, unknown>) {
  const r = await call('POST', '/v1/posts', u, { clientId: clientId(), ...body });
  if (r.status !== 201) throw new Error(`post failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.post;
}

const follow = (a: TestUser, b: TestUser) => call('POST', `/v1/users/${b.id}/follow`, a);
const feedIds = async (u: TestUser) => (await call('GET', '/v1/feed', u)).body.posts.map((p: { id: string }) => p.id);
const canSee = async (u: TestUser, postId: string) => (await call('GET', `/v1/posts/${postId}`, u)).status === 200;

describe('follows', () => {
  it('follows public accounts straight away and shows it on profiles', async () => {
    const [a, b] = [await user(), await user()];
    const r = await follow(a, b);
    expect(r.body).toEqual({ following: 'active', followsYou: false });
    const prof = (await call('GET', `/v1/users/${b.username}`, a)).body;
    expect(prof).toMatchObject({ followerCount: 1, followingCount: 0, privateAccount: false, relationship: { following: 'active', followsYou: false } });
    expect((await call('GET', `/v1/users/${a.username}`, b)).body.relationship).toEqual({ following: 'none', followsYou: true });
    expect((await call('GET', `/v1/users/${b.username}`, b)).body.relationship).toBeNull();
    expect((await call('GET', `/v1/users/${b.id}/followers`, a)).body.users.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await call('GET', `/v1/users/${a.id}/following`, b)).body.users.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await call('DELETE', `/v1/users/${b.id}/follow`, a)).body.following).toBe('none');
    expect((await call('POST', `/v1/users/${a.id}/follow`, a)).status).toBe(400);
  });

  it('makes private accounts approve followers and hides their lists', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await call('PATCH', '/v1/me/privacy', b, { privateAccount: true });
    expect((await follow(a, b)).body.following).toBe('pending');
    expect((await follow(c, b)).body.following).toBe('pending');
    expect((await call('GET', `/v1/users/${b.id}/followers`, a)).status).toBe(404);
    const reqs = (await call('GET', '/v1/me/follow-requests', b)).body.requests.map((r: { user: { id: string } }) => r.user.id);
    expect(reqs.sort()).toEqual([a.id, c.id].sort());
    expect((await call('POST', `/v1/me/follow-requests/${a.id}`, b, { approve: true })).status).toBe(204);
    expect((await call('POST', `/v1/me/follow-requests/${a.id}`, b, { approve: true })).status).toBe(404);
    expect((await call('GET', `/v1/users/${b.id}/followers`, a)).status).toBe(200);
    // Going public accepts everyone still waiting.
    await call('PATCH', '/v1/me/privacy', b, { privateAccount: false });
    expect((await call('GET', `/v1/users/${b.username}`, c)).body.relationship.following).toBe('active');
    // Removing a follower.
    expect((await call('DELETE', `/v1/me/followers/${c.id}`, b)).status).toBe(204);
    expect((await call('GET', `/v1/users/${b.username}`, c)).body.relationship.following).toBe('none');
  });

  it('ends follows both ways on a block and refuses new ones', async () => {
    const [a, b] = [await user(), await user()];
    await follow(a, b);
    await follow(b, a);
    await call('POST', '/v1/blocks', a, { userId: b.id });
    expect((await call('GET', `/v1/users/${a.id}/followers`, a)).body.users).toEqual([]);
    expect((await call('GET', `/v1/users/${a.id}/following`, a)).body.users).toEqual([]);
    expect((await follow(b, a)).status).toBe(404);
    expect((await follow(a, b)).status).toBe(404);
  });
});

describe('posts and the feed', () => {
  it('builds the feed from your posts and people you follow, newest first, with paging', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await follow(a, b);
    const p1 = await post(b, { body: 'b one' });
    const p2 = await post(c, { body: 'c not followed' });
    const p3 = await post(a, { body: 'a own' });
    const p4 = await post(b, { body: 'b two' });
    expect(await feedIds(a)).toEqual([p4.id, p3.id, p1.id]);
    expect(await feedIds(a)).not.toContain(p2.id);
    const page1 = (await call('GET', '/v1/feed?limit=2', a)).body;
    expect(page1.posts.map((p: { id: string }) => p.id)).toEqual([p4.id, p3.id]);
    const page2 = (await call('GET', `/v1/feed?limit=2&cursor=${page1.nextCursor}`, a)).body;
    expect(page2).toEqual({ posts: [expect.objectContaining({ id: p1.id })], nextCursor: null });
    expect(p4).toMatchObject({ author: { id: b.id, username: b.username }, audience: 'public', likeCount: 0, liked: false, shared: null, removed: null });
  });

  it('is idempotent on clientId and rejects empty posts', async () => {
    const a = await user();
    const cid = clientId();
    const r1 = await call('POST', '/v1/posts', a, { clientId: cid, body: 'once' });
    const r2 = await call('POST', '/v1/posts', a, { clientId: cid, body: 'once' });
    expect([r1.status, r2.status]).toEqual([201, 200]);
    expect(r2.body).toMatchObject({ duplicate: true, post: { id: r1.body.post.id } });
    expect((await call('POST', '/v1/posts', a, { clientId: clientId(), body: '   ' })).status).toBe(400);
  });

  it('applies audiences: public, followers only, only me, and private accounts', async () => {
    const [a, follower, stranger] = [await user(), await user(), await user()];
    await follow(follower, a);
    const pub = await post(a, { body: 'hello world', audience: 'public' });
    const fol = await post(a, { body: 'friends', audience: 'followers' });
    const me = await post(a, { body: 'diary', audience: 'only_me' });
    expect([await canSee(follower, pub.id), await canSee(follower, fol.id), await canSee(follower, me.id)]).toEqual([true, true, false]);
    expect([await canSee(stranger, pub.id), await canSee(stranger, fol.id), await canSee(stranger, me.id)]).toEqual([true, false, false]);
    expect(await canSee(a, me.id)).toBe(true);
    const profile = (await call('GET', `/v1/users/${a.id}/posts`, stranger)).body.posts.map((p: { id: string }) => p.id);
    expect(profile).toEqual([pub.id]);

    // A private account's "public" posts are for approved followers only.
    await call('PATCH', '/v1/me/privacy', a, { privateAccount: true });
    expect(await canSee(stranger, pub.id)).toBe(false);
    expect(await canSee(follower, pub.id)).toBe(true);
    // Changing a post's audience takes effect at once.
    await call('PATCH', `/v1/posts/${fol.id}`, a, { audience: 'only_me' });
    expect(await canSee(follower, fol.id)).toBe(false);
  });

  it('hides everything between people who blocked each other, including likes and comments', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const p = await post(a, { body: 'open to all' });
    await call('PUT', `/v1/posts/${p.id}/like`, b, { liked: true });
    await call('PUT', `/v1/posts/${p.id}/like`, c, { liked: true });
    await call('POST', `/v1/posts/${p.id}/comments`, b, { body: 'from b' });
    await call('POST', `/v1/posts/${p.id}/comments`, c, { body: 'from c' });
    await call('POST', '/v1/blocks', b, { userId: c.id });
    // c no longer sees b's like or comment on a's post, and the counts agree.
    const seenByC = (await call('GET', `/v1/posts/${p.id}`, c)).body;
    expect([seenByC.likeCount, seenByC.commentCount]).toEqual([1, 1]);
    expect((await call('GET', `/v1/posts/${p.id}/comments`, c)).body.comments.map((x: { body: string }) => x.body)).toEqual(['from c']);
    expect((await call('GET', `/v1/posts/${p.id}/likes`, c)).body.users.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect((await call('GET', `/v1/posts/${p.id}`, a)).body.likeCount).toBe(2);
    // The blocked author's posts are gone for both.
    await call('POST', '/v1/blocks', a, { userId: c.id });
    expect(await canSee(c, p.id)).toBe(false);
    expect((await call('PUT', `/v1/posts/${p.id}/like`, c, { liked: false })).status).toBe(404);
    expect((await call('POST', `/v1/posts/${p.id}/comments`, c, { body: 'still here?' })).status).toBe(404);
    expect((await call('GET', `/v1/users/${a.id}/posts`, c)).status).toBe(404);
  });

  it('likes, comments and lets the right people delete comments', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const p = await post(a, { body: 'discuss' });
    expect((await call('PUT', `/v1/posts/${p.id}/like`, b, { liked: true })).body).toEqual({ liked: true, likeCount: 1 });
    expect((await call('PUT', `/v1/posts/${p.id}/like`, b, { liked: true })).body).toEqual({ liked: true, likeCount: 1 });
    expect((await call('PUT', `/v1/posts/${p.id}/like`, b, { liked: false })).body).toEqual({ liked: false, likeCount: 0 });
    const cb = (await call('POST', `/v1/posts/${p.id}/comments`, b, { body: 'b says' })).body;
    const cc = (await call('POST', `/v1/posts/${p.id}/comments`, c, { body: 'c says' })).body;
    expect(cb).toMatchObject({ postId: p.id, author: { id: b.id }, body: 'b says' });
    expect((await call('DELETE', `/v1/comments/${cb.id}`, c)).status).toBe(403);
    expect((await call('DELETE', `/v1/comments/${cb.id}`, b)).status).toBe(204); // own comment
    expect((await call('DELETE', `/v1/comments/${cc.id}`, a)).status).toBe(204); // post author
    expect((await call('GET', `/v1/posts/${p.id}`, a)).body.commentCount).toBe(0);
  });

  it('pages comments oldest first', async () => {
    const [a, b] = [await user(), await user()];
    const p = await post(a, { body: 'thread' });
    for (const n of [1, 2, 3]) await call('POST', `/v1/posts/${p.id}/comments`, b, { body: `c${n}` });
    const first = (await call('GET', `/v1/posts/${p.id}/comments?limit=2`, a)).body;
    expect(first.comments.map((c: { body: string }) => c.body)).toEqual(['c1', 'c2']);
    const rest = (await call('GET', `/v1/posts/${p.id}/comments?limit=2&cursor=${first.nextCursor}`, a)).body;
    expect(rest.comments.map((c: { body: string }) => c.body)).toEqual(['c3']);
  });

  it('shares posts without widening who can see the original', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await follow(b, a);
    const original = await post(a, { body: 'followers only', audience: 'followers' });
    const share = await post(b, { sharedPostId: original.id, body: 'look at this' });
    expect(share.shared).toMatchObject({ id: original.id, body: 'followers only' });
    // c can see b's public share but not a's followers-only original.
    const seen = (await call('GET', `/v1/posts/${share.id}`, c)).body;
    expect(seen.body).toBe('look at this');
    expect(seen.shared).toEqual({ id: original.id, unavailable: true });
    // You can't share what you can't see.
    expect((await call('POST', '/v1/posts', c, { clientId: clientId(), sharedPostId: original.id })).status).toBe(404);
    // Sharing a plain share shares the original.
    await follow(c, a);
    const plain = await post(b, { sharedPostId: original.id });
    const reshare = await post(c, { sharedPostId: plain.id });
    expect(reshare.shared.id).toBe(original.id);
  });

  it('edits and deletes only your own posts, and deletes their files', async () => {
    const [a, b] = [await user(), await user()];
    const mediaId = await image(a);
    const p = await post(a, { body: 'with a photo', mediaIds: [mediaId] });
    expect(p.media).toEqual([expect.objectContaining({ id: mediaId, kind: 'image', width: 1 })]);
    expect((await call('PATCH', `/v1/posts/${p.id}`, b, { body: 'hacked' })).status).toBe(403);
    const edited = (await call('PATCH', `/v1/posts/${p.id}`, a, { body: 'with a nice photo' })).body;
    expect(edited.body).toBe('with a nice photo');
    expect(edited.editedAt).not.toBeNull();
    expect((await call('DELETE', `/v1/posts/${p.id}`, b)).status).toBe(403);
    expect((await call('DELETE', `/v1/posts/${p.id}`, a)).status).toBe(204);
    expect(await canSee(a, p.id)).toBe(false);
    const { rows } = await pool.query('SELECT state FROM media WHERE id = $1', [mediaId]);
    expect(rows[0].state).toBe('deleted');
  });

  it('lets exactly the post audience download its photos', async () => {
    const [a, follower, stranger] = [await user(), await user(), await user()];
    await follow(follower, a);
    const mediaId = await image(a);
    await post(a, { body: 'for followers', audience: 'followers', mediaIds: [mediaId] });
    expect((await call('GET', `/v1/media/${mediaId}`, follower)).status).toBe(200);
    expect((await call('GET', `/v1/media/${mediaId}`, stranger)).status).toBe(404);
    // Others can't attach your upload to their post.
    expect((await call('POST', '/v1/posts', stranger, { clientId: clientId(), mediaIds: [mediaId] })).status).toBe(404);
  });
});

describe('stories', () => {
  it('shows a story tray of you and people you follow, tracks views, and lets only the author see viewers', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await follow(a, b);
    await follow(c, b);
    const s1 = (await call('POST', '/v1/stories', b, { kind: 'text', body: 'Good morning', background: '#112233' })).body;
    expect(s1).toMatchObject({ kind: 'text', body: 'Good morning', background: '#112233', audience: 'followers', viewed: false, viewCount: 0 });
    const mine = (await call('POST', '/v1/stories', a, { kind: 'text', body: 'Me too' })).body;

    const tray = (await call('GET', '/v1/stories', a)).body.groups;
    expect(tray.map((g: { author: { id: string } }) => g.author.id)).toEqual([a.id, b.id]);
    expect(tray[1]).toMatchObject({ allViewed: false, stories: [expect.objectContaining({ id: s1.id, viewCount: null })] });
    expect(tray[0].stories[0].id).toBe(mine.id);

    expect((await call('POST', `/v1/stories/${s1.id}/views`, a)).status).toBe(204);
    expect((await call('POST', `/v1/stories/${s1.id}/views`, a)).status).toBe(204);
    expect((await call('POST', `/v1/stories/${s1.id}/views`, b)).status).toBe(204); // author: not counted
    expect((await call('GET', '/v1/stories', a)).body.groups[1].allViewed).toBe(true);
    expect((await call('GET', `/v1/stories/${s1.id}`, b)).body.viewCount).toBe(1);
    const viewers = (await call('GET', `/v1/stories/${s1.id}/views`, b)).body.viewers;
    expect(viewers.map((v: { user: { id: string } }) => v.user.id)).toEqual([a.id]);
    expect((await call('GET', `/v1/stories/${s1.id}/views`, a)).status).toBe(404);
    expect((await call('GET', `/v1/users/${b.id}/stories`, c)).body.stories).toHaveLength(1);
  });

  it('keeps followers-only stories from everyone else and validates content', async () => {
    const [a, b] = [await user(), await user()];
    const s = (await call('POST', '/v1/stories', a, { kind: 'text', body: 'secret' })).body;
    expect((await call('GET', `/v1/stories/${s.id}`, b)).status).toBe(404);
    expect((await call('POST', `/v1/stories/${s.id}/views`, b)).status).toBe(404);
    const pub = (await call('POST', '/v1/stories', a, { kind: 'text', body: 'for all', audience: 'public' })).body;
    expect((await call('GET', `/v1/stories/${pub.id}`, b)).status).toBe(200);
    // Not following: public stories are viewable by link but don't fill b's tray.
    expect((await call('GET', '/v1/stories', b)).body.groups).toEqual([]);
    expect((await call('POST', '/v1/stories', a, { kind: 'text', body: ' ' })).status).toBe(400);
    expect((await call('POST', '/v1/stories', a, { kind: 'image' })).status).toBe(400);
    expect((await call('POST', '/v1/stories', a, { kind: 'text', body: 'x', background: 'red' })).status).toBe(400);
  });

  it('expires stories after 24 hours and the sweep deletes them with their files', async () => {
    const [a, b] = [await user(), await user()];
    await follow(b, a);
    const mediaId = await image(a);
    const s = (await call('POST', '/v1/stories', a, { kind: 'image', mediaId, body: 'sunset' })).body;
    expect(new Date(s.expiresAt).getTime() - new Date(s.createdAt).getTime()).toBe(24 * 3600 * 1000);
    expect((await call('GET', `/v1/media/${mediaId}`, b)).status).toBe(200);
    await pool.query(`UPDATE stories SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.id]);
    expect((await call('GET', `/v1/stories/${s.id}`, b)).status).toBe(404);
    expect((await call('GET', `/v1/media/${mediaId}`, b)).status).toBe(404);
    expect(await ctx.app.get(StoriesService).purgeExpired()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query('SELECT state FROM media WHERE id = $1', [mediaId]);
    expect(rows[0].state).toBe('deleted');
  });

  it('lets authors delete a story early', async () => {
    const [a, b] = [await user(), await user()];
    const s = (await call('POST', '/v1/stories', a, { kind: 'text', body: 'oops' })).body;
    expect((await call('DELETE', `/v1/stories/${s.id}`, b)).status).toBe(404);
    expect((await call('DELETE', `/v1/stories/${s.id}`, a)).status).toBe(204);
    expect((await call('GET', `/v1/stories/${s.id}`, a)).status).toBe(404);
  });
});

describe('communities and channels', () => {
  async function community(owner: TestUser, extra: Record<string, unknown> = {}) {
    const slug = `c${clientId().slice(-12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const r = await call('POST', '/v1/communities', owner, { slug, name: `Gardening ${slug}`, ...extra });
    if (r.status !== 201) throw new Error(`community failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  it('creates a public community anyone can find, read and join', async () => {
    const [a, b] = [await user(), await user()];
    const c = await community(a, { description: 'Tomatoes and more' });
    expect(c).toMatchObject({ kind: 'community', visibility: 'public', memberCount: 1, membership: { role: 'owner', state: 'active' } });
    expect((await call('POST', '/v1/communities', b, { slug: c.slug, name: 'Copycat' })).body.error.code).toBe('slug_taken');
    expect((await call('GET', `/v1/communities/${c.slug}`, b)).body.id).toBe(c.id);
    const found = (await call('GET', `/v1/communities?q=${encodeURIComponent('gardening')}`, b)).body.communities.map((x: { id: string }) => x.id);
    expect(found).toContain(c.id);

    const p = await post(a, { communityId: c.id, body: 'Welcome!' });
    expect(p.community).toMatchObject({ id: c.id, slug: c.slug });
    expect(await canSee(b, p.id)).toBe(true);
    expect((await call('POST', '/v1/posts', b, { clientId: clientId(), communityId: c.id, body: 'hi' })).status).toBe(403);
    const joined = (await call('POST', `/v1/communities/${c.id}/join`, b)).body;
    expect(joined).toMatchObject({ memberCount: 2, membership: { role: 'member', state: 'active' } });
    const bp = await post(b, { communityId: c.id, body: 'Glad to be here' });
    expect(bp.audience).toBe('public');
    // Community posts show in members' home feeds.
    expect(await feedIds(b)).toEqual(expect.arrayContaining([p.id, bp.id]));
    expect((await call('GET', `/v1/communities/${c.id}/posts`, b)).body.posts.map((x: { id: string }) => x.id)).toEqual([bp.id, p.id]);
    expect((await call('GET', '/v1/communities', b)).body.communities.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect((await call('DELETE', `/v1/communities/${c.id}/membership`, b)).status).toBe(204);
    expect((await call('DELETE', `/v1/communities/${c.id}/membership`, a)).body.error.code).toBe('owner_cannot_leave');
  });

  it('keeps a private community’s posts and members to approved members', async () => {
    const [a, b] = [await user(), await user()];
    const c = await community(a, { visibility: 'private' });
    const p = await post(a, { communityId: c.id, body: 'members only' });
    expect((await call('GET', `/v1/communities/${c.id}`, b)).body.membership).toBeNull();
    expect(await canSee(b, p.id)).toBe(false);
    expect((await call('GET', `/v1/communities/${c.id}/posts`, b)).status).toBe(404);
    expect((await call('GET', `/v1/communities/${c.id}/members`, b)).status).toBe(404);
    expect((await call('POST', `/v1/communities/${c.id}/join`, b)).body.membership.state).toBe('pending');
    expect(await canSee(b, p.id)).toBe(false);
    expect((await call('GET', `/v1/communities/${c.id}/members?state=pending`, b)).status).toBe(404);
    const pending = (await call('GET', `/v1/communities/${c.id}/members?state=pending`, a)).body.members;
    expect(pending.map((m: { user: { id: string } }) => m.user.id)).toEqual([b.id]);
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${b.id}`, a, { state: 'active' })).body).toEqual({ userId: b.id, role: 'member', state: 'active' });
    expect(await canSee(b, p.id)).toBe(true);
  });

  it('lets only admins post in a channel', async () => {
    const [a, b] = [await user(), await user()];
    const ch = await community(a, { kind: 'channel' });
    await call('POST', `/v1/communities/${ch.id}/join`, b);
    expect((await call('POST', '/v1/posts', b, { clientId: clientId(), communityId: ch.id, body: 'can I?' })).status).toBe(403);
    const news = await post(a, { communityId: ch.id, body: 'Release notes' });
    expect(await feedIds(b)).toContain(news.id);
  });

  it('moderates: remove posts and comments, ban people, and respect rank', async () => {
    const [owner, mod, member, other] = [await user(), await user(), await user(), await user()];
    const c = await community(owner);
    for (const u of [mod, member, other]) await call('POST', `/v1/communities/${c.id}/join`, u);
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${mod.id}`, owner, { role: 'moderator' })).body.role).toBe('moderator');
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${other.id}`, mod, { role: 'moderator' })).body.error.code).toBe('outranked');
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${owner.id}`, mod, { state: 'banned' })).body.error.code).toBe('outranked');

    const spam = await post(member, { communityId: c.id, body: 'Buy now!!!' });
    const cm = (await call('POST', `/v1/posts/${spam.id}/comments`, other, { body: 'spam' })).body;
    expect((await call('POST', `/v1/posts/${spam.id}/moderation`, other, { removed: true })).status).toBe(403);
    expect((await call('DELETE', `/v1/comments/${cm.id}`, mod)).status).toBe(204);
    expect((await call('POST', `/v1/posts/${spam.id}/moderation`, mod, { removed: true, reason: 'Spam' })).status).toBe(204);
    expect(await canSee(other, spam.id)).toBe(false);
    // The author still sees it, with the reason.
    expect((await call('GET', `/v1/posts/${spam.id}`, member)).body.removed).toMatchObject({ reason: 'Spam' });
    const { rows } = await pool.query(`SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'community.%' ORDER BY id`, [mod.id]);
    expect(rows.map((r) => r.action)).toEqual(['community.comment.removed', 'community.post.removed']);

    // Banning: the person loses access and can't rejoin; the community looks like it doesn't exist.
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${member.id}`, mod, { state: 'banned' })).body.state).toBe('banned');
    expect((await call('GET', `/v1/communities/${c.id}`, member)).status).toBe(404);
    expect((await call('POST', `/v1/communities/${c.id}/join`, member)).status).toBe(404);
    expect((await call('GET', `/v1/communities/${c.id}/members?state=banned`, mod)).body.members.map((m: { user: { id: string } }) => m.user.id)).toEqual([member.id]);
    // Lifting the ban.
    expect((await call('DELETE', `/v1/communities/${c.id}/members/${member.id}`, mod)).status).toBe(204);
    expect((await call('POST', `/v1/communities/${c.id}/join`, member)).body.membership.state).toBe('active');
  });

  it('hands over and deletes communities, owner only', async () => {
    const [a, b] = [await user(), await user()];
    const c = await community(a);
    await call('POST', `/v1/communities/${c.id}/join`, b);
    expect((await call('DELETE', `/v1/communities/${c.id}`, b)).status).toBe(403);
    expect((await call('PATCH', `/v1/communities/${c.id}`, b, { name: 'Mine' })).status).toBe(403);
    expect((await call('PATCH', `/v1/communities/${c.id}`, a, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await call('PATCH', `/v1/communities/${c.id}/members/${b.id}`, a, { role: 'owner' })).body.role).toBe('owner');
    expect((await call('GET', `/v1/communities/${c.id}`, a)).body.membership.role).toBe('admin');
    expect((await call('DELETE', `/v1/communities/${c.id}`, b)).status).toBe(204);
    expect((await call('GET', `/v1/communities/${c.id}`, a)).status).toBe(404);
  });
});

describe('reports and accounts', () => {
  it('accepts reports on comments, stories and communities', async () => {
    const a = await user();
    for (const subjectType of ['post', 'comment', 'story', 'community']) {
      const r = await call('POST', '/v1/reports', a, { subjectType, subjectId: '00000000-0000-4000-8000-000000000001', reason: 'spam' });
      expect([subjectType, r.status]).toEqual([subjectType, 201]);
    }
  });

  it('exports social data and deletes it with the account', async () => {
    const [a, b] = [await user(), await user()];
    await follow(a, b);
    await follow(b, a);
    const mediaId = await image(a);
    const p = await post(a, { body: 'mine', mediaIds: [mediaId] });
    const bp = await post(b, { body: 'theirs' });
    await call('PUT', `/v1/posts/${bp.id}/like`, a, { liked: true });
    await call('POST', `/v1/posts/${bp.id}/comments`, a, { body: 'nice' });
    await call('POST', '/v1/stories', a, { kind: 'text', body: 'today' });
    const owned = (await call('POST', '/v1/communities', a, { slug: `own${Date.now() % 1e8}`, name: 'Owned' })).body;
    await call('POST', `/v1/communities/${owned.id}/join`, b);

    const exp = (await call('GET', '/v1/me/export', a)).body;
    expect(exp.posts.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect(exp.posts[0].media_ids).toEqual([mediaId]);
    expect(exp.comments).toHaveLength(1);
    expect(exp.likes).toHaveLength(1);
    expect(exp.stories).toHaveLength(1);
    expect(exp.communities).toHaveLength(1);
    expect(exp.follows).toHaveLength(2);

    expect((await call('DELETE', '/v1/me', a, { password: a.password })).status).toBe(204);
    expect(await canSee(b, p.id)).toBe(false);
    const theirs = (await call('GET', `/v1/posts/${bp.id}`, b)).body;
    expect([theirs.likeCount, theirs.commentCount]).toEqual([0, 0]);
    expect((await call('GET', `/v1/users/${b.id}/followers`, b)).body.users).toEqual([]);
    expect((await call('GET', `/v1/communities/${owned.id}`, b)).body.membership.role).toBe('owner');
    const left = await pool.query(
      `SELECT (SELECT count(*) FROM posts WHERE author_id = $1) + (SELECT count(*) FROM stories WHERE author_id = $1)
            + (SELECT count(*) FROM follows WHERE follower_id = $1 OR followee_id = $1) + (SELECT count(*) FROM community_members WHERE user_id = $1) AS n`,
      [a.id],
    );
    expect(Number(left.rows[0].n)).toBe(0);
    expect((await pool.query('SELECT state FROM media WHERE id = $1', [mediaId])).rows[0].state).toBe('deleted');
  });

  it('hides a deactivated account’s posts', async () => {
    const [a, b] = [await user(), await user()];
    const p = await post(a, { body: 'here today' });
    await call('POST', '/v1/me/deactivate', a, { password: a.password });
    expect(await canSee(b, p.id)).toBe(false);
  });
});

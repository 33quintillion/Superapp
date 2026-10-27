import { Pool } from 'pg';
import { grantPlatformRole } from '../src/admin/grant';
import { totp } from '../src/crypto/totp';
import { IntegrationsService } from '../src/integrations/integrations.service';
import { clientId, nextIp, registerUser, req, startApp, TEST_ENV, TestContext, TestUser, uniqueUser } from './helpers';

// The admin dashboard's API: who may use it (platform staff with a recent two-step
// sign-in), the report queue and its actions, and the integration catalogue's kill switch.
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

const user = () => registerUser(ctx.app, 'a');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

interface Staff extends TestUser {
  email: string;
  secret: string;
}

/** A new account with two-step on, made platform staff, signed in with a code. */
async function staffMember(role: 'admin' | 'moderator'): Promise<Staff> {
  const u = uniqueUser('adm');
  const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
  const token = reg.body.accessToken;
  const { secret } = (await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token })).body;
  expect((await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token, body: { code: totp(secret, Date.now() - 30_000) } })).status).toBe(204);
  await grantPlatformRole(pool, u.email, role);
  const step1 = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password }, ip: nextIp() });
  const step2 = await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: step1.body.mfaToken, code: totp(secret) }, ip: nextIp() });
  expect(step2.status).toBe(200);
  const me = await req(ctx.app, 'GET', '/v1/me', { token: step2.body.accessToken });
  return { id: me.body.id, token: step2.body.accessToken, sessionId: step2.body.sessionId, username: u.username, password: u.password, email: u.email, secret };
}

async function post(u: TestUser, body = 'hello world') {
  return (await call('POST', '/v1/posts', u, { clientId: clientId(), body })).body.post as { id: string };
}

const report = (u: TestUser, subjectType: string, subjectId: string, reason = 'spam') => call('POST', '/v1/reports', u, { subjectType, subjectId, reason, details: 'see this' });

let admin: Staff;
let mod: Staff;
beforeAll(async () => {
  admin = await staffMember('admin');
  mod = await staffMember('moderator');
});

describe('who can use the admin dashboard', () => {
  it('refuses people who are not platform staff', async () => {
    const u = await user();
    const r = await call('GET', '/v1/admin/overview', u);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_platform_staff');
  });

  it('requires two-step verification to be on', async () => {
    const u = uniqueUser('nomfa');
    const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
    await grantPlatformRole(pool, u.email, 'admin');
    const r = await req(ctx.app, 'GET', '/v1/admin/overview', { token: reg.body.accessToken });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('mfa_required');
  });

  it('requires the session itself to have been opened with a two-step code, recently', async () => {
    // Two-step turned on after signing in: this session never saw a code.
    const u = uniqueUser('late');
    const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
    const token = reg.body.accessToken;
    const { secret } = (await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token })).body;
    await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token, body: { code: totp(secret) } });
    await grantPlatformRole(pool, u.email, 'admin');
    expect((await req(ctx.app, 'GET', '/v1/admin/overview', { token })).body.error.code).toBe('mfa_reauth_required');

    // A refreshed session keeps its two-step mark, until it is too old.
    const fresh = await staffMember('moderator');
    expect((await call('GET', '/v1/admin/overview', fresh)).status).toBe(200);
    await pool.query(`UPDATE sessions SET mfa_verified_at = now() - interval '13 hours' WHERE id = $1`, [fresh.sessionId]);
    expect((await call('GET', '/v1/admin/overview', fresh)).body.error.code).toBe('mfa_reauth_required');
  });

  it('lets moderators work the queue but keeps admin areas to admins', async () => {
    expect((await call('GET', '/v1/admin/overview', mod)).body.role).toBe('moderator');
    expect((await call('GET', '/v1/admin/reports', mod)).status).toBe(200);
    for (const path of ['/v1/admin/businesses', '/v1/admin/integrations', '/v1/admin/staff', '/v1/admin/audit']) {
      const r = await call('GET', path, mod);
      expect([path, r.status, r.body.error.code]).toEqual([path, 403, 'admin_only']);
      expect((await call('GET', path, admin)).status).toBe(200);
    }
  });

  it('stops working the moment staff status is removed', async () => {
    const m = await staffMember('moderator');
    expect((await call('GET', '/v1/admin/overview', m)).status).toBe(200);
    expect((await call('DELETE', `/v1/admin/staff/${m.id}`, admin)).status).toBe(204);
    expect((await call('GET', '/v1/admin/overview', m)).body.error.code).toBe('not_platform_staff');
    // Admins can't be removed through the API, only from the command line.
    expect((await call('DELETE', `/v1/admin/staff/${admin.id}`, admin)).status).toBe(404);
  });
});

describe('the report queue', () => {
  it('lists open reports with child safety first, claims them, and shows what was reported', async () => {
    const [author, r1] = [await user(), await user()];
    const p = await post(author, 'buy followers now');
    const spam = (await report(r1, 'post', p.id)).body;
    const other = await post(author, 'something worse');
    const urgent = (await report(r1, 'post', other.id, 'child_safety')).body;
    const queue = (await call('GET', '/v1/admin/reports?limit=100', mod)).body.reports.map((r: { id: string }) => r.id);
    expect(queue.indexOf(urgent.id)).toBeLessThan(queue.indexOf(spam.id));
    expect(queue.indexOf(urgent.id)).toBeGreaterThanOrEqual(0);

    const detail = (await call('GET', `/v1/admin/reports/${spam.id}`, mod)).body;
    expect(detail).toMatchObject({ status: 'open', reason: 'spam', reporter: { id: r1.id }, subject: { body: 'buy followers now', author: { id: author.id }, removed: false } });
    const claimed = (await call('POST', `/v1/admin/reports/${spam.id}/claim`, mod)).body;
    expect(claimed).toMatchObject({ status: 'in_review', assignedTo: mod.id });
    expect((await call('GET', '/v1/admin/reports?subjectType=post&limit=100', mod)).body.reports.map((r: { id: string }) => r.id)).toContain(spam.id);
  });

  it('removes reported content, closes every report about it, and hides it from everyone', async () => {
    const [author, r1, r2, viewer] = [await user(), await user(), await user(), await user()];
    const p = await post(author);
    const a = (await report(r1, 'post', p.id)).body;
    const b = (await report(r2, 'post', p.id, 'harassment')).body;
    expect((await call('GET', `/v1/admin/reports/${a.id}`, mod)).body).toMatchObject({ otherOpenReports: 1, related: [expect.objectContaining({ id: b.id })] });

    expect((await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'action' })).status).toBe(400);
    expect((await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'dismiss', removeContent: true })).status).toBe(400);
    const done = (await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'action', removeContent: true, note: 'Spam' })).body;
    expect(done).toMatchObject({ status: 'actioned', resolvedBy: mod.id, actions: ['content_removed'], resolutionNote: 'Spam', subject: { removed: true } });
    expect((await call('GET', `/v1/admin/reports/${b.id}`, mod)).body).toMatchObject({ status: 'actioned', actions: ['content_removed'] });
    expect((await call('GET', `/v1/posts/${p.id}`, viewer)).status).toBe(404);
    // The author still sees it, with the reason.
    expect((await call('GET', `/v1/posts/${p.id}`, author)).body.removed).toMatchObject({ reason: 'Spam' });
    expect((await call('POST', `/v1/admin/reports/${b.id}/resolve`, mod, { decision: 'dismiss' })).body.error.code).toBe('report_closed');
    expect((await call('GET', '/v1/admin/reports?status=closed&limit=100', mod)).body.reports.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('dismisses a report without touching the content', async () => {
    const [author, r1, viewer] = [await user(), await user(), await user()];
    const p = await post(author);
    const a = (await report(r1, 'post', p.id)).body;
    expect((await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'dismiss', note: 'Fine' })).body).toMatchObject({ status: 'dismissed', actions: [] });
    expect((await call('GET', `/v1/posts/${p.id}`, viewer)).status).toBe(200);
  });

  it('suspends an author: signed out everywhere, sign-in refused, posts hidden, until lifted', async () => {
    const [author, r1, viewer] = [await user(), await user(), await user()];
    const p = await post(author);
    const a = (await report(r1, 'user', author.id, 'harassment')).body;
    expect((await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'action', removeContent: true })).status).toBe(400);
    const done = (await call('POST', `/v1/admin/reports/${a.id}/resolve`, mod, { decision: 'action', suspendAuthor: true, note: 'Repeated abuse' })).body;
    expect(done).toMatchObject({ status: 'actioned', actions: ['user_suspended'], subject: { state: 'suspended' } });
    expect((await call('GET', '/v1/me', author)).status).toBe(401);
    const login = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: `${author.username}@example.test`, password: author.password }, ip: nextIp() });
    expect([login.status, login.body.error.code]).toEqual([403, 'account_suspended']);
    // A wrong password still says only "incorrect", so suspension can't be probed.
    const wrong = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: `${author.username}@example.test`, password: 'not the password' }, ip: nextIp() });
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect((await call('GET', `/v1/posts/${p.id}`, viewer)).status).toBe(404);
    expect((await call('GET', `/v1/users/${author.username}`, viewer)).status).toBe(404);

    const found = (await call('GET', `/v1/admin/users?q=${author.username}`, mod)).body.users[0];
    expect(found).toMatchObject({ state: 'suspended', suspensionReason: 'Repeated abuse', reportsAgainst: 1 });
    expect(found.email).toBeUndefined();
    expect((await call('GET', `/v1/admin/users?q=${author.username}`, admin)).body.users[0].email).toBe(`${author.username}@example.test`);

    expect((await call('POST', `/v1/admin/users/${author.id}/unsuspend`, mod, {})).body.state).toBe('active');
    const back = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: `${author.username}@example.test`, password: author.password }, ip: nextIp() });
    expect(back.status).toBe(200);
  });

  it('shows only the reported message, and removes it for everyone in the chat', async () => {
    const [sender, recipient] = [await user(), await user()];
    const conv = (await call('POST', '/v1/conversations/direct', recipient, { userId: sender.id })).body;
    const send = async (body: string) => (await call('POST', `/v1/conversations/${conv.id}/messages`, sender, { clientId: clientId(), body })).body.message;
    await send('earlier, unrelated');
    const bad = await send('threatening message');
    const r = (await report(recipient, 'message', bad.id, 'harassment')).body;
    const detail = (await call('GET', `/v1/admin/reports/${r.id}`, mod)).body;
    expect(detail.subject).toMatchObject({ body: 'threatening message', author: { id: sender.id }, removed: false });
    expect(JSON.stringify(detail)).not.toContain('earlier, unrelated');
    await call('POST', `/v1/admin/reports/${r.id}/resolve`, mod, { decision: 'action', removeContent: true });
    const history = (await call('GET', `/v1/conversations/${conv.id}/messages`, recipient)).body.messages;
    expect(history.find((m: { id: string }) => m.id === bad.id)).toMatchObject({ body: null, deletedAt: expect.any(String) });
    expect(history.find((m: { body: string }) => m.body === 'earlier, unrelated')).toBeTruthy();
  });

  it('protects staff accounts and keeps business removals to admins', async () => {
    const r1 = await user();
    const own = (await report(r1, 'user', mod.id)).body;
    expect((await call('POST', `/v1/admin/reports/${own.id}/resolve`, mod, { decision: 'action', suspendAuthor: true })).status).toBe(400);
    const staffReport = (await report(r1, 'user', admin.id)).body;
    expect((await call('POST', `/v1/admin/reports/${staffReport.id}/resolve`, mod, { decision: 'action', suspendAuthor: true })).body.error.code).toBe('staff_protected');

    const owner = await user();
    const b = (await call('POST', '/v1/businesses', owner, { handle: `scam-${process.pid % 10000}`, name: 'Scam Ltd', category: 'retail', timeZone: 'UTC', currency: 'USD' })).body;
    const br = (await report(r1, 'business', b.id, 'fraud')).body;
    expect((await call('POST', `/v1/admin/reports/${br.id}/resolve`, mod, { decision: 'action', removeContent: true })).body.error.code).toBe('admin_only');
    expect((await call('POST', `/v1/admin/reports/${br.id}/resolve`, admin, { decision: 'action', removeContent: true, note: 'Fraud' })).body.subject.state).toBe('suspended');
    expect((await call('GET', `/v1/businesses/${b.id}`, r1)).status).toBe(404);
    expect((await call('GET', `/v1/businesses/${b.id}`, owner)).body).toMatchObject({ state: 'suspended', suspensionReason: 'Fraud' });
  });
});

describe('businesses, staff and the audit log', () => {
  it('verifies, suspends and restores businesses', async () => {
    const owner = await user();
    const b = (await call('POST', '/v1/businesses', owner, { handle: `bakery-${process.pid % 10000}`, name: 'Good Bakery', category: 'food', timeZone: 'UTC', currency: 'EUR' })).body;
    const act = (action: string, reason = '') => call('POST', `/v1/admin/businesses/${b.id}/actions`, admin, { action, reason });
    expect((await act('verify')).body).toMatchObject({ verified: true, owner: { id: owner.id } });
    expect((await call('GET', `/v1/businesses/${b.handle}`, owner)).body.verified).toBe(true);
    expect((await act('suspend', 'Health inspection')).body.state).toBe('suspended');
    expect((await act('suspend')).body.error.code).toBe('no_change');
    expect((await call('GET', '/v1/admin/businesses?state=suspended', admin)).body.businesses.map((x: { id: string }) => x.id)).toContain(b.id);
    expect((await act('unsuspend')).body.state).toBe('active');
    expect((await call('POST', `/v1/admin/businesses/${b.id}/actions`, mod, { action: 'suspend' })).status).toBe(403);
  });

  it('adds moderators by username and records every admin action', async () => {
    const u = await user();
    const staff = (await call('POST', '/v1/admin/staff', admin, { username: u.username })).body.staff;
    expect(staff).toEqual(expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ id: u.id }), role: 'moderator', twoStepOn: false })]));
    expect((await call('POST', '/v1/admin/staff', admin, { username: u.username })).body.error.code).toBe('already_staff');
    // Without two-step they still can't get in.
    expect((await call('GET', '/v1/admin/overview', u)).body.error.code).toBe('mfa_required');

    const log = (await call('GET', '/v1/admin/audit?action=admin.&limit=200', admin)).body.entries;
    expect(log.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['admin.staff.granted', 'admin.report.actioned', 'admin.user.suspended']));
    expect(log.find((e: { action: string; targetId: string }) => e.action === 'admin.staff.granted' && e.targetId === u.id).actor.id).toBe(admin.id);
    expect(JSON.stringify(log)).not.toMatch(/"ip"/);
    const older = (await call('GET', `/v1/admin/audit?limit=1&before=${log[0].id}`, admin)).body.entries;
    expect(older[0].id).toBeLessThan(log[0].id);
  });

  it('grants and removes roles from the command line', async () => {
    const u = uniqueUser('cli');
    await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
    expect(await grantPlatformRole(pool, u.email, 'moderator')).toMatchObject({ twoStepOn: false });
    expect((await pool.query('SELECT role FROM platform_staff ps JOIN users x ON x.id = ps.user_id WHERE x.email = $1', [u.email])).rows).toEqual([{ role: 'moderator' }]);
    await grantPlatformRole(pool, u.email, 'none');
    expect((await pool.query('SELECT 1 FROM platform_staff ps JOIN users x ON x.id = ps.user_id WHERE x.email = $1', [u.email])).rowCount).toBe(0);
    await expect(grantPlatformRole(pool, 'nobody@example.test', 'admin')).rejects.toThrow(/No active account/);
  });

  it('gives the overview counts', async () => {
    const o = (await call('GET', '/v1/admin/overview', admin)).body;
    expect(o).toMatchObject({ role: 'admin', reports: { open: expect.any(Number), childSafety: expect.any(Number) }, users: { active: expect.any(Number) } });
    expect(o.reports.childSafety).toBeGreaterThanOrEqual(1);
  });
});

describe('integration catalogue and the kill switch', () => {
  let seq = 0;
  async function integration(scopes = ['profile.basic', 'orders.read']) {
    seq += 1;
    const r = await call('POST', '/v1/admin/integrations', admin, {
      slug: `food-${process.pid % 10000}-${seq}`,
      name: `Food Partner ${seq}`,
      category: 'food',
      developerName: 'Partner Ltd',
      developerContact: 'dev@partner.test',
      homepageUrl: 'https://partner.test',
      scopes,
    });
    expect(r.status).toBe(201);
    return r.body;
  }
  const svc = () => ctx.app.get(IntegrationsService);

  it('only lists integrations once an admin publishes them', async () => {
    const u = await user();
    const i = await integration();
    expect(i).toMatchObject({ state: 'draft', developer: { name: 'Partner Ltd', contact: 'dev@partner.test' } });
    expect((await call('GET', '/v1/integrations', u)).body.integrations.map((x: { id: string }) => x.id)).not.toContain(i.id);
    expect((await call('GET', `/v1/integrations/${i.slug}`, u)).status).toBe(404);
    expect((await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'live' })).body).toMatchObject({ state: 'live', reviewedAt: expect.any(String) });
    const listed = (await call('GET', '/v1/integrations?category=food', u)).body.integrations.find((x: { id: string }) => x.id === i.id);
    expect(listed).toMatchObject({ grant: null, scopes: [{ scope: 'orders.read', description: expect.any(String) }, { scope: 'profile.basic', description: expect.any(String) }] });
    // People don't see the developer's private contact.
    expect(listed.developer).toEqual({ name: 'Partner Ltd' });
    expect((await call('POST', '/v1/admin/integrations', admin, { slug: i.slug, name: 'x', category: 'food', developerName: 'x', developerContact: 'x@x.test', homepageUrl: 'https://x.test' })).body.error.code).toBe('slug_taken');
    expect((await call('POST', '/v1/admin/integrations', admin, { slug: 'insecure-1', name: 'x', category: 'food', developerName: 'x', developerContact: 'x@x.test', homepageUrl: 'http://x.test' })).status).toBe(400);
    expect((await call('POST', '/v1/admin/integrations', admin, { slug: 'greedy-1', name: 'x', category: 'food', developerName: 'x', developerContact: 'x@x.test', homepageUrl: 'https://x.test', scopes: ['messages.read'] })).status).toBe(400);
  });

  it('grants only scopes it asks for, and the person can revoke them', async () => {
    const u = await user();
    const i = await integration();
    await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'live' });
    expect((await call('PUT', `/v1/integrations/${i.slug}/connection`, u, { scopes: ['email'] })).status).toBe(400);
    const c = (await call('PUT', `/v1/integrations/${i.slug}/connection`, u, { scopes: ['profile.basic'] })).body;
    expect(c.grant).toMatchObject({ scopes: ['profile.basic'], active: true });
    expect(await svc().hasGrant(u.id, i.id, 'profile.basic')).toBe(true);
    expect(await svc().hasGrant(u.id, i.id, 'orders.read')).toBe(false);
    expect((await call('GET', '/v1/me/integrations', u)).body.integrations.map((x: { id: string }) => x.id)).toEqual([i.id]);
    expect((await call('GET', '/v1/me/export', u)).body.integrations).toEqual([expect.objectContaining({ slug: i.slug, scopes: ['profile.basic'] })]);
    expect((await call('DELETE', `/v1/integrations/${i.slug}/connection`, u)).status).toBe(204);
    expect(await svc().hasGrant(u.id, i.id, 'profile.basic')).toBe(false);
    expect((await call('DELETE', `/v1/integrations/${i.slug}/connection`, u)).status).toBe(404);
  });

  it('switches an integration off for everyone at once, and back on', async () => {
    const u = await user();
    const i = await integration();
    await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'live' });
    await call('PUT', `/v1/integrations/${i.slug}/connection`, u, { scopes: ['orders.read'] });
    expect((await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'disabled', reason: 'Data leak under investigation' })).body).toMatchObject({ state: 'disabled', disabledReason: 'Data leak under investigation' });
    expect(await svc().hasGrant(u.id, i.id, 'orders.read')).toBe(false);
    expect((await call('GET', '/v1/integrations', u)).body.integrations.map((x: { id: string }) => x.id)).not.toContain(i.id);
    // The person still sees what they granted, marked as paused, and can revoke it.
    expect((await call('GET', `/v1/integrations/${i.slug}`, u)).body.grant).toMatchObject({ scopes: ['orders.read'], active: false });
    expect((await call('PUT', `/v1/integrations/${i.slug}/connection`, u, { scopes: ['orders.read'] })).status).toBe(404);
    await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'live' });
    expect(await svc().hasGrant(u.id, i.id, 'orders.read')).toBe(true);
    expect((await call('GET', '/v1/admin/integrations', admin)).body.integrations.find((x: { id: string }) => x.id === i.id).connections).toBe(1);
  });

  it('sends an integration back for review when it asks for more, and trims grants when it asks for less', async () => {
    const u = await user();
    const i = await integration(['profile.basic', 'orders.read']);
    await call('POST', `/v1/admin/integrations/${i.id}/state`, admin, { state: 'live' });
    await call('PUT', `/v1/integrations/${i.slug}/connection`, u, { scopes: ['profile.basic', 'orders.read'] });
    expect((await call('PATCH', `/v1/admin/integrations/${i.id}`, admin, { scopes: ['orders.read'] })).body.state).toBe('live');
    expect((await call('GET', `/v1/integrations/${i.slug}`, u)).body.grant.scopes).toEqual(['orders.read']);
    expect((await call('PATCH', `/v1/admin/integrations/${i.id}`, admin, { scopes: ['orders.read', 'email'], version: '1.1.0' })).body).toMatchObject({ state: 'draft', version: '1.1.0', reviewedAt: null });
    expect(await svc().hasGrant(u.id, i.id, 'orders.read')).toBe(false);
    expect((await call('PATCH', `/v1/admin/integrations/${i.id}`, mod, { name: 'x' })).status).toBe(403);
  });
});

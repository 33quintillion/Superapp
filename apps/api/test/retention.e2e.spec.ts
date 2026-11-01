import { DatabaseService } from '../src/database/database.service';
import { RetentionService } from '../src/retention/retention.service';
import { StorageService } from '../src/storage/storage.service';
import { nextIp, registerUser, req, resetDatabase, startApp, TestContext } from './helpers';

// The retention sweep against real Postgres and object storage. Ages are set by moving
// timestamps back, rather than waiting.

let ctx: TestContext;
let db: DatabaseService;
let sweep: () => ReturnType<RetentionService['sweep']>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await startApp();
  db = ctx.app.get(DatabaseService);
  const retention = ctx.app.get(RetentionService);
  sweep = () => retention.sweep();
});
afterAll(() => ctx.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe('retention sweep', () => {
  it('deletes sessions 90 days after they ended, keeping recent and live ones', async () => {
    const u = await registerUser(ctx.app, 'ret');
    const login = async () =>
      (await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: `${u.username}@example.test`, password: u.password }, ip: nextIp() })).body.sessionId as string;
    const [oldRevoked, recentRevoked, oldExpired, live] = [await login(), await login(), await login(), await login()];
    await db.query(`UPDATE sessions SET revoked_at = now() - interval '91 days' WHERE id = $1`, [oldRevoked]);
    await db.query(`UPDATE sessions SET revoked_at = now() - interval '10 days' WHERE id = $1`, [recentRevoked]);
    await db.query(`UPDATE sessions SET expires_at = now() - interval '91 days' WHERE id = $1`, [oldExpired]);
    // A live session that has been in use for a long time is untouched.
    await db.query(`UPDATE sessions SET created_at = now() - interval '400 days' WHERE id = $1`, [live]);

    expect((await sweep()).sessions).toBe(2);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1', [u.id]);
    expect(rows.map((r) => r.id).sort()).toEqual([u.sessionId, recentRevoked, live].sort());
  });

  it('deletes email, reset and two-step links a week after they were used or expired', async () => {
    const u = await registerUser(ctx.app, 'ret');
    await req(ctx.app, 'POST', '/v1/auth/password/forgot', { body: { email: `${u.username}@example.test` } });
    const count = async () => Number((await db.one<{ n: string }>('SELECT count(*) AS n FROM one_time_tokens WHERE user_id = $1', [u.id]))!.n);
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(2); // email confirmation and reset
    await sweep();
    expect(await count()).toBe(before);
    await db.query(`UPDATE one_time_tokens SET expires_at = now() - interval '8 days' WHERE user_id = $1 AND purpose = 'reset_password'`, [u.id]);
    await db.query(`UPDATE one_time_tokens SET used_at = now() - interval '8 days' WHERE user_id = $1 AND purpose = 'verify_email'`, [u.id]);
    expect((await sweep()).oneTimeTokens).toBe(before);
    expect(await count()).toBe(0);
  });

  it('deletes uploads that were never finished, and their files, after a day', async () => {
    const u = await registerUser(ctx.app, 'ret');
    const start = async () => {
      const r = await req(ctx.app, 'POST', '/v1/media/uploads', { token: u.token, body: { kind: 'image', contentType: 'image/png', byteSize: PNG.length } });
      await fetch(r.body.upload.url, { method: 'PUT', headers: r.body.upload.headers, body: PNG });
      return r.body.media.id as string;
    };
    const [abandoned, recent, finished] = [await start(), await start(), await start()];
    expect((await req(ctx.app, 'POST', `/v1/media/${finished}/complete`, { token: u.token })).status).toBe(200);
    await db.query(`UPDATE media SET created_at = now() - interval '25 hours' WHERE id = ANY($1)`, [[abandoned, finished]]);
    const key = async (id: string) => (await db.one<{ object_key: string }>('SELECT object_key FROM media WHERE id = $1', [id]))!.object_key;
    const stored = async (id: string) => !!(await ctx.app.get(StorageService).head(await key(id)));

    expect((await sweep()).abandonedUploads).toBe(1);
    expect(await stored(abandoned)).toBe(false);
    expect((await db.one<{ state: string }>('SELECT state FROM media WHERE id = $1', [abandoned]))!.state).toBe('deleted');
    expect(await stored(recent)).toBe(true);
    expect(await stored(finished)).toBe(true);
    // Too late to finish it now.
    expect((await req(ctx.app, 'POST', `/v1/media/${abandoned}/complete`, { token: u.token })).status).not.toBe(200);
  });

  it('keeps the tombstones of deleted accounts and messages', async () => {
    const u = await registerUser(ctx.app, 'ret');
    expect((await req(ctx.app, 'DELETE', '/v1/me', { token: u.token, body: { password: u.password } })).status).toBe(204);
    await db.query(`UPDATE users SET deleted_at = now() - interval '5 years' WHERE id = $1`, [u.id]);
    await sweep();
    const row = await db.one<{ state: string; email: string | null; display_name: string }>('SELECT state, email, display_name FROM users WHERE id = $1', [u.id]);
    expect(row).toEqual({ state: 'deleted', email: null, display_name: '' });
  });
});

import { Pool } from 'pg';
import { registerUser, req, startApp, TEST_ENV, TestContext, TestUser } from './helpers';

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

const user = () => registerUser(ctx.app, 'mp');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

let n = 0;
async function shop(owner: TestUser) {
  n += 1;
  const r = await call('POST', '/v1/businesses', owner, { handle: `janpath-${process.pid % 10000}-${n}`, name: `Hotel New Janpath ${n}`, category: 'food', timeZone: 'Asia/Kolkata', currency: 'INR' });
  expect(r.status).toBe(201);
  return r.body as { id: string; handle: string };
}

async function withStaff(owner: TestUser, bid: string, role: 'manager' | 'staff') {
  const u = await user();
  await call('POST', `/v1/businesses/${bid}/staff`, owner, { username: u.username, role });
  await call('POST', `/v1/businesses/${bid}/staff/accept`, u);
  return u;
}

const program = (extra: Record<string, unknown> = {}) => ({
  name: 'Janpath Dining',
  tagline: 'Order ahead or book a room',
  icon: '🍛',
  accent: 'burgundy',
  pages: [
    {
      id: 'home',
      title: 'Welcome',
      blocks: [
        { type: 'heading', text: 'Welcome to Hotel New Janpath' },
        { type: 'text', text: 'On the Ahmedabad-Viramgam Highway.' },
        { type: 'button', label: 'See the menu', action: { type: 'page', pageId: 'menu' } },
        { type: 'button', label: 'Book a table', action: { type: 'book' } },
        { type: 'button', label: 'Call us', action: { type: 'call' } },
        { type: 'hours' },
        { type: 'location', lat: 23.12, lng: 72.04, label: 'Jakhwada, Viramgam' },
      ],
    },
    { id: 'menu', title: 'Menu', blocks: [{ type: 'items', title: 'Today' }, { type: 'divider' }, { type: 'button', label: 'Order for pickup', action: { type: 'order' } }] },
  ],
  ...extra,
});

describe('mini-programs', () => {
  it('managers edit a draft and publish it; customers see only what is published', async () => {
    const owner = await user();
    const b = await shop(owner);
    const manager = await withStaff(owner, b.id, 'manager');
    const staff = await withStaff(owner, b.id, 'staff');
    const customer = await user();

    expect((await call('GET', `/v1/businesses/${b.id}/mini-program`, owner)).body).toEqual({ miniProgram: null });
    expect((await call('POST', `/v1/businesses/${b.id}/mini-program/publish`, owner)).body.error.code).toBe('nothing_to_publish');

    const saved = await call('PUT', `/v1/businesses/${b.id}/mini-program`, manager, program());
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ businessId: b.id, published: null, draft: { name: 'Janpath Dining', pages: [{ id: 'home' }, { id: 'menu' }] } });
    expect(saved.body.draft.pages[1].blocks[0]).toEqual({ type: 'items', title: 'Today' });

    // Staff can look, not change. Customers and strangers can't even look.
    expect((await call('GET', `/v1/businesses/${b.id}/mini-program`, staff)).status).toBe(200);
    expect((await call('PUT', `/v1/businesses/${b.id}/mini-program`, staff, program())).status).toBe(403);
    expect((await call('GET', `/v1/businesses/${b.id}/mini-program`, customer)).status).toBe(404);
    expect((await call('GET', `/v1/mini-programs/${saved.body.id}`, customer)).status).toBe(404);
    expect((await call('GET', '/v1/mini-programs', customer)).body.miniPrograms.map((m: { id: string }) => m.id)).not.toContain(saved.body.id);

    const live = await call('POST', `/v1/businesses/${b.id}/mini-program/publish`, owner);
    expect(live.body.published).toEqual(live.body.draft);
    const opened = await call('GET', `/v1/mini-programs/${saved.body.id}`, customer);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ id: saved.body.id, name: 'Janpath Dining', icon: '🍛', accent: 'burgundy', business: { id: b.id, handle: b.handle } });

    // A new draft doesn't change what customers see until it's published again.
    await call('PUT', `/v1/businesses/${b.id}/mini-program`, owner, program({ name: 'Janpath Draft' }));
    expect((await call('GET', `/v1/mini-programs/${saved.body.id}`, customer)).body.name).toBe('Janpath Dining');

    const list = await call('GET', '/v1/mini-programs?q=janpath', customer);
    expect(list.body.miniPrograms).toContainEqual(expect.objectContaining({ id: saved.body.id, name: 'Janpath Dining', hasMenu: true, business: expect.objectContaining({ id: b.id }) }));
    expect((await call('GET', '/v1/me/mini-programs/recent', customer)).body.miniPrograms.map((m: { id: string }) => m.id)).toEqual([saved.body.id]);

    // Unpublished, or the business suspended: gone for customers.
    await call('DELETE', `/v1/businesses/${b.id}/mini-program/publish`, owner);
    expect((await call('GET', `/v1/mini-programs/${saved.body.id}`, customer)).status).toBe(404);
    expect((await call('GET', '/v1/me/mini-programs/recent', customer)).body.miniPrograms).toEqual([]);
    await call('POST', `/v1/businesses/${b.id}/mini-program/publish`, owner);
    expect((await call('GET', `/v1/mini-programs/${saved.body.id}`, customer)).status).toBe(200);
    await pool.query(`UPDATE businesses SET state = 'suspended' WHERE id = $1`, [b.id]);
    expect((await call('GET', `/v1/mini-programs/${saved.body.id}`, customer)).status).toBe(404);
  });

  it('accepts only known blocks, safe links and buttons that go somewhere', async () => {
    const owner = await user();
    const b = await shop(owner);
    const put = (body: unknown) => call('PUT', `/v1/businesses/${b.id}/mini-program`, owner, body);
    for (const bad of [
      program({ pages: [] }),
      program({ pages: [{ id: 'home', title: 'x', blocks: [{ type: 'script', code: 'alert(1)' }] }] }),
      program({ pages: [{ id: 'home', title: 'x', blocks: [{ type: 'button', label: 'Go', action: { type: 'link', url: 'javascript:alert(1)' } }] }] }),
      program({ pages: [{ id: 'home', title: 'x', blocks: [{ type: 'button', label: 'Go', action: { type: 'link', url: 'http://plain.example' } }] }] }),
      program({ pages: [{ id: 'home', title: 'x', blocks: [{ type: 'button', label: 'Go', action: { type: 'page', pageId: 'nowhere' } }] }] }),
      program({ pages: [{ id: 'home', title: 'a', blocks: [] }, { id: 'home', title: 'b', blocks: [] }] }),
      program({ pages: Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, title: 'x', blocks: [] })) }),
      program({ icon: 'not an emoji' }),
      program({ accent: 'pink' }),
      program({ name: '' }),
      program({ pages: [{ id: 'home', title: 'x', blocks: Array.from({ length: 41 }, () => ({ type: 'divider' })) }] }),
    ]) {
      expect((await put(bad)).status).toBe(400);
    }
    const ok = await put(program({ pages: [{ id: 'home', title: 'x', blocks: [{ type: 'button', label: 'Website', action: { type: 'link', url: 'https://example.com/rooms' } }] }] }));
    expect(ok.status).toBe(200);
  });
});

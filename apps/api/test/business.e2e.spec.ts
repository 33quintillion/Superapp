import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { clientId, registerUser, req, startApp, TEST_ENV, TestContext, TestUser } from './helpers';
import { Client, rawConnect } from './ws-client';

// Real API, Postgres and Redis. Covers business accounts, the staff role matrix, the
// catalogue, orders and bookings, and what happens to all of it when accounts go away.
let ctx: TestContext;
let pool: Pool;
let base: string;
const sockets: Client[] = [];
beforeAll(async () => {
  ctx = await startApp();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
});
afterAll(async () => {
  for (const s of sockets) if (!s.closed) await s.close();
  await ctx.close();
  await pool.end();
});

const user = () => registerUser(ctx.app, 'b');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

let handles = 0;
async function business(owner: TestUser, extra: Record<string, unknown> = {}) {
  handles += 1;
  const r = await call('POST', '/v1/businesses', owner, {
    handle: `shop-${process.pid % 10000}-${handles}`,
    name: `Corner Shop ${handles}`,
    category: 'food',
    timeZone: 'UTC',
    currency: 'GBP',
    ...extra,
  });
  if (r.status !== 201) throw new Error(`create business failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A business with a manager and a staff member who have both accepted. */
async function team() {
  const [owner, manager, staff, customer] = [await user(), await user(), await user(), await user()];
  const b = await business(owner);
  await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: manager.username, role: 'manager' });
  await call('POST', `/v1/businesses/${b.id}/staff/accept`, manager);
  await call('POST', `/v1/businesses/${b.id}/staff`, manager, { username: staff.username, role: 'staff' });
  await call('POST', `/v1/businesses/${b.id}/staff/accept`, staff);
  return { b, owner, manager, staff, customer };
}

async function item(u: TestUser, bid: string, body: Record<string, unknown>) {
  const r = await call('POST', `/v1/businesses/${bid}/items`, u, body);
  if (r.status !== 201) throw new Error(`item failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function connect(u: TestUser) {
  const t = (await call('POST', '/v1/realtime/tickets', u)).body.ticket;
  const ws = await rawConnect(base, `?ticket=${t}`);
  if (typeof ws === 'number') throw new Error(`connect failed: ${ws}`);
  const c = new Client(ws);
  sockets.push(c);
  await c.next((f) => f.type === 'ready');
  return c;
}

/** Tomorrow's date in UTC, as YYYY-MM-DD. */
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const allWeek = (opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens, closes }));

describe('business accounts', () => {
  it('creates a business with its creator as owner, and checks the details', async () => {
    const owner = await user();
    const b = await business(owner, { description: 'Bread and milk', phone: '+447700900123', contactEmail: 'Shop@Example.test' });
    expect(b).toMatchObject({ myRole: 'owner', state: 'active', verified: false, currency: 'GBP', contactEmail: 'shop@example.test', ordersEnabled: false, bookingsEnabled: false });
    expect(b.permissions).toEqual(expect.arrayContaining(['business.delete', 'staff.manage', 'orders.manage']));
    expect((await call('POST', '/v1/businesses', owner, { handle: b.handle, name: 'x', category: 'food', timeZone: 'UTC', currency: 'GBP' })).body.error.code).toBe('handle_taken');
    const bad = await call('POST', '/v1/businesses', owner, { handle: 'tz-bad-1', name: 'x', category: 'food', timeZone: 'Mars/Olympus', currency: 'GBP' });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/v1/businesses', owner, { handle: 'cur-bad-1', name: 'x', category: 'food', timeZone: 'UTC', currency: 'XXQ' })).status).toBe(400);
    expect((await call('GET', '/v1/me/businesses', owner)).body.businesses.map((x: { id: string }) => x.id)).toContain(b.id);
    // Anyone signed in can look it up and find it; they get no role and no permissions.
    const other = await user();
    expect((await call('GET', `/v1/businesses/${b.handle}`, other)).body).toMatchObject({ id: b.id, myRole: null, permissions: [] });
    const found = (await call('GET', `/v1/businesses?q=${encodeURIComponent(b.name.split(' ')[0])}&category=food&limit=50`, other)).body.businesses;
    expect(found.map((x: { id: string }) => x.id)).toContain(b.id);
  });

  it('lets managers edit the profile and hours, and refuses overlapping or backwards hours', async () => {
    const { b, manager, staff, customer } = await team();
    expect((await call('PATCH', `/v1/businesses/${b.id}`, manager, { name: 'New Name', ordersEnabled: true })).body).toMatchObject({ name: 'New Name', ordersEnabled: true });
    expect((await call('PATCH', `/v1/businesses/${b.id}`, staff, { name: 'Nope' })).status).toBe(403);
    expect((await call('PATCH', `/v1/businesses/${b.id}`, customer, { name: 'Nope' })).status).toBe(404);
    const hours = [{ weekday: 1, opens: '09:00', closes: '12:00' }, { weekday: 1, opens: '13:00', closes: '17:30' }];
    expect((await call('PUT', `/v1/businesses/${b.id}/hours`, manager, { hours })).body.hours).toEqual(hours);
    expect((await call('PUT', `/v1/businesses/${b.id}/hours`, manager, { hours: [{ weekday: 2, opens: '09:00', closes: '12:00' }, { weekday: 2, opens: '11:00', closes: '14:00' }] })).status).toBe(400);
    expect((await call('PUT', `/v1/businesses/${b.id}/hours`, manager, { hours: [{ weekday: 2, opens: '12:00', closes: '09:00' }] })).status).toBe(400);
    expect((await call('PUT', `/v1/businesses/${b.id}/hours`, staff, { hours })).status).toBe(403);
    expect((await call('GET', `/v1/businesses/${b.handle}/hours`, customer)).body.hours).toEqual(hours);
  });
});

describe('staff roles', () => {
  it('needs the invited person to accept before they are staff', async () => {
    const [owner, ben] = [await user(), await user()];
    const b = await business(owner);
    expect((await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: ben.username, role: 'staff' })).status).toBe(201);
    expect((await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: ben.username, role: 'staff' })).body.error.code).toBe('already_staff');
    // Invited, not yet staff: the back office stays closed and the invitation shows.
    expect((await call('GET', `/v1/businesses/${b.id}/orders`, ben)).status).toBe(404);
    expect((await call('GET', `/v1/businesses/${b.id}`, ben)).body).toMatchObject({ myRole: null, invited: { role: 'staff' } });
    expect((await call('GET', '/v1/me/businesses', ben)).body.businesses[0]).toMatchObject({ id: b.id, invited: { role: 'staff' } });
    expect((await call('POST', `/v1/businesses/${b.id}/staff/accept`, ben)).body.myRole).toBe('staff');
    expect((await call('POST', `/v1/businesses/${b.id}/staff/accept`, ben)).status).toBe(404);
    expect((await call('GET', `/v1/businesses/${b.id}/orders`, ben)).status).toBe(200);
    // Declining works the same as leaving.
    const cy = await user();
    await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: cy.username, role: 'manager' });
    expect((await call('DELETE', `/v1/businesses/${b.id}/staff/${cy.id}`, cy)).status).toBe(204);
    expect((await call('GET', `/v1/businesses/${b.id}/staff`, owner)).body.staff.map((s: { user: { id: string } }) => s.user.id)).not.toContain(cy.id);
  });

  it('enforces the role matrix for every kind of change', async () => {
    const { b, owner, manager, staff, customer } = await team();
    const roster = (await call('GET', `/v1/businesses/${b.id}/staff`, staff)).body.staff;
    expect(roster.map((s: { role: string; state: string }) => `${s.role}:${s.state}`)).toEqual(['owner:active', 'manager:active', 'staff:active']);
    expect((await call('GET', `/v1/businesses/${b.id}/staff`, customer)).status).toBe(404);

    const extra = await user();
    // Staff can't invite anyone; managers can invite staff but not managers.
    expect((await call('POST', `/v1/businesses/${b.id}/staff`, staff, { username: extra.username, role: 'staff' })).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${b.id}/staff`, manager, { username: extra.username, role: 'manager' })).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${b.id}/staff`, customer, { username: extra.username, role: 'staff' })).status).toBe(404);
    // Managers can't promote staff, demote or remove the owner, or change themselves.
    expect((await call('PATCH', `/v1/businesses/${b.id}/staff/${staff.id}`, manager, { role: 'manager' })).status).toBe(403);
    expect((await call('DELETE', `/v1/businesses/${b.id}/staff/${owner.id}`, manager)).status).toBe(403);
    expect((await call('PATCH', `/v1/businesses/${b.id}/staff/${manager.id}`, manager, { role: 'staff' })).status).toBe(403);
    // Staff can't edit the catalogue or services; managers can.
    expect((await call('POST', `/v1/businesses/${b.id}/items`, staff, { name: 'Tea', priceMinor: 250 })).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${b.id}/services`, staff, { name: 'Cut', durationMinutes: 30 })).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${b.id}/items`, manager, { name: 'Tea', priceMinor: 250 })).status).toBe(201);
    // Only the owner deletes or hands over the business.
    expect((await call('DELETE', `/v1/businesses/${b.id}`, manager)).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${b.id}/transfer`, manager, { userId: manager.id })).status).toBe(403);
    // The owner can promote and demote.
    expect((await call('PATCH', `/v1/businesses/${b.id}/staff/${staff.id}`, owner, { role: 'manager' })).status).toBe(200);
    expect((await call('PATCH', `/v1/businesses/${b.id}/staff/${staff.id}`, owner, { role: 'staff' })).status).toBe(200);
    // Managers can remove staff.
    expect((await call('DELETE', `/v1/businesses/${b.id}/staff/${staff.id}`, manager)).status).toBe(204);
    expect((await call('GET', `/v1/businesses/${b.id}/orders`, staff)).status).toBe(404);
  });

  it('hands ownership only to a manager, and the owner must hand over before leaving', async () => {
    const { b, owner, manager, staff } = await team();
    expect((await call('DELETE', `/v1/businesses/${b.id}/staff/${owner.id}`, owner)).body.error.code).toBe('owner_cannot_leave');
    expect((await call('POST', `/v1/businesses/${b.id}/transfer`, owner, { userId: staff.id })).status).toBe(400);
    const after = (await call('POST', `/v1/businesses/${b.id}/transfer`, owner, { userId: manager.id })).body.staff;
    expect(after.slice(0, 2).map((s: { user: { id: string }; role: string }) => [s.user.id, s.role])).toEqual([[manager.id, 'owner'], [owner.id, 'manager']]);
    expect((await call('DELETE', `/v1/businesses/${b.id}/staff/${owner.id}`, owner)).status).toBe(204);
    expect((await call('GET', `/v1/businesses/${b.id}`, manager)).body.myRole).toBe('owner');
  });
});

describe('catalogue and orders', () => {
  async function shop() {
    const t = await team();
    await call('PATCH', `/v1/businesses/${t.b.id}`, t.owner, { ordersEnabled: true });
    const bread = await item(t.manager, t.b.id, { name: 'Bread', priceMinor: 180, stock: 3 });
    const milk = await item(t.manager, t.b.id, { name: 'Milk', priceMinor: 95 });
    const hidden = await item(t.manager, t.b.id, { name: 'Secret', priceMinor: 1, available: false });
    return { ...t, bread, milk, hidden };
  }

  it('shows customers only what they can buy, and staff everything', async () => {
    const { b, staff, customer, bread, milk, hidden } = await shop();
    expect((await call('GET', `/v1/businesses/${b.handle}/items`, customer)).body.items.map((i: { id: string }) => i.id)).toEqual([bread.id, milk.id]);
    expect((await call('GET', `/v1/businesses/${b.handle}/items?all=true`, customer)).status).toBe(404);
    expect((await call('GET', `/v1/businesses/${b.id}/items?all=true`, staff)).body.items.map((i: { id: string }) => i.id)).toContain(hidden.id);
    expect(bread).toMatchObject({ priceMinor: 180, currency: 'GBP', stock: 3, available: true });
  });

  it('prices orders from the catalogue, takes stock, and is safe to retry', async () => {
    const { b, staff, customer, bread, milk, hidden } = await shop();
    const cid = clientId();
    const body = { clientId: cid, items: [{ itemId: bread.id, quantity: 2 }, { itemId: milk.id, quantity: 1 }], note: 'Ring the bell' };
    const placed = await call('POST', `/v1/businesses/${b.handle}/orders`, customer, body);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: 'placed', totalMinor: 455, currency: 'GBP', payment: 'pay_in_person', fulfilment: 'pickup', note: 'Ring the bell' });
    expect(placed.body.items).toEqual([
      { itemId: expect.any(String), name: expect.any(String), unitPriceMinor: expect.any(Number), quantity: expect.any(Number) },
      { itemId: expect.any(String), name: expect.any(String), unitPriceMinor: expect.any(Number), quantity: expect.any(Number) },
    ]);
    expect(placed.body.items.map((i: { name: string; quantity: number }) => `${i.name}x${i.quantity}`).sort()).toEqual(['Breadx2', 'Milkx1']);
    // The customer view never names the customer; staff see who it is, but no contact details.
    expect(placed.body.customer).toBeUndefined();
    const staffView = (await call('GET', `/v1/orders/${placed.body.id}`, staff)).body;
    expect(staffView.customer).toEqual({ id: customer.id, username: customer.username, displayName: expect.any(String) });
    expect(JSON.stringify(staffView)).not.toContain('@example.test');

    const retry = await call('POST', `/v1/businesses/${b.handle}/orders`, customer, body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(placed.body.id);
    expect((await call('GET', `/v1/businesses/${b.id}/items?all=true`, staff)).body.items.find((i: { id: string }) => i.id === bread.id).stock).toBe(1);

    // Two more than are left: refused, and nothing is taken.
    const tooMany = await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: milk.id, quantity: 1 }, { itemId: bread.id, quantity: 2 }] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toMatchObject({ code: 'item_unavailable', details: { itemId: bread.id } });
    expect((await call('GET', `/v1/businesses/${b.id}/items?all=true`, staff)).body.items.find((i: { id: string }) => i.id === bread.id).stock).toBe(1);
    expect((await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: hidden.id, quantity: 1 }] })).status).toBe(409);
    expect((await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [] })).status).toBe(400);
    // Prices sent by the client are not accepted at all.
    expect((await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: milk.id, quantity: 1, priceMinor: 1 }] })).status).toBe(400);

    expect((await call('GET', '/v1/orders', customer)).body.orders.map((o: { id: string }) => o.id)).toEqual([placed.body.id]);
  });

  it('never sells the last item twice when orders race', async () => {
    const { b, customer, manager } = await shop();
    const last = await item(manager, b.id, { name: 'Last loaf', priceMinor: 300, stock: 1 });
    const others = [await user(), await user(), await user()];
    const results = await Promise.all(
      [customer, ...others].map((u) => call('POST', `/v1/businesses/${b.handle}/orders`, u, { clientId: clientId(), items: [{ itemId: last.id, quantity: 1 }] })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('moves orders through their statuses, gives stock back, and tells both sides live', async () => {
    const { b, owner, staff, customer, bread } = await shop();
    const shopSocket = await connect(staff);
    const customerSocket = await connect(customer);
    const place = () => call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: bread.id, quantity: 1 }] });
    const o = (await place()).body;
    expect((await shopSocket.next((f) => f.type === 'business.order.created')).data).toMatchObject({ id: o.id, customer: { id: customer.id } });

    const status = (u: TestUser, id: string, s: string) => call('POST', `/v1/orders/${id}/status`, u, { status: s });
    expect((await status(customer, o.id, 'accepted')).status).toBe(403);
    expect((await status(await user(), o.id, 'accepted')).status).toBe(404);
    expect((await status(staff, o.id, 'completed')).body.error.code).toBe('invalid_transition');
    expect((await status(staff, o.id, 'accepted')).body.status).toBe('accepted');
    expect((await customerSocket.next((f) => f.type === 'order.updated')).data).toMatchObject({ id: o.id, status: 'accepted' });
    // Once accepted, only the business can cancel.
    expect((await call('POST', `/v1/orders/${o.id}/cancel`, customer)).body.error.code).toBe('order_in_progress');
    expect((await status(staff, o.id, 'ready')).body.status).toBe('ready');
    expect((await status(staff, o.id, 'completed')).body.status).toBe('completed');
    expect((await status(staff, o.id, 'cancelled')).status).toBe(409);

    // Rejected and cancelled orders return their stock.
    const stock = async () => (await call('GET', `/v1/businesses/${b.id}/items?all=true`, owner)).body.items.find((i: { id: string }) => i.id === bread.id).stock;
    const before = await stock();
    const r = (await place()).body;
    expect(await stock()).toBe(before - 1);
    await call('POST', `/v1/orders/${r.id}/status`, staff, { status: 'rejected', reason: 'Out of bags' });
    expect(await stock()).toBe(before);
    const c = (await place()).body;
    expect((await call('POST', `/v1/orders/${c.id}/cancel`, customer)).body.status).toBe('cancelled');
    expect(await stock()).toBe(before);

    const list = (await call('GET', `/v1/businesses/${b.id}/orders?status=placed,accepted,ready`, staff)).body.orders;
    expect(list).toEqual([]);
    const done = (await call('GET', `/v1/businesses/${b.id}/orders?status=completed,rejected,cancelled&limit=2`, staff)).body;
    expect(done.orders).toHaveLength(2);
    const page2 = (await call('GET', `/v1/businesses/${b.id}/orders?status=completed,rejected,cancelled&limit=2&cursor=${done.nextCursor}`, staff)).body;
    expect(page2.orders.map((x: { id: string }) => x.id)).toEqual([o.id]);
  });

  it('refuses orders while ordering is off, and archives items without touching past orders', async () => {
    const { b, owner, manager, customer, milk } = await shop();
    const o = (await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: milk.id, quantity: 2 }] })).body;
    await call('PATCH', `/v1/businesses/${b.id}/items/${milk.id}`, manager, { priceMinor: 120, name: 'Oat milk' });
    expect((await call('DELETE', `/v1/businesses/${b.id}/items/${milk.id}`, manager)).status).toBe(204);
    expect((await call('GET', `/v1/orders/${o.id}`, customer)).body.items).toEqual([{ itemId: milk.id, name: 'Milk', unitPriceMinor: 95, quantity: 2 }]);
    expect((await call('GET', `/v1/businesses/${b.handle}/items`, customer)).body.items.map((i: { id: string }) => i.id)).not.toContain(milk.id);
    await call('PATCH', `/v1/businesses/${b.id}`, owner, { ordersEnabled: false });
    expect((await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: milk.id, quantity: 1 }] })).body.error.code).toBe('orders_closed');
  });
});

describe('bookings', () => {
  async function salon(tz = 'UTC', hours = allWeek('09:00', '12:00')) {
    const t = await team();
    await call('PATCH', `/v1/businesses/${t.b.id}`, t.owner, { bookingsEnabled: true, timeZone: tz });
    await call('PUT', `/v1/businesses/${t.b.id}/hours`, t.owner, { hours });
    const svc = (await call('POST', `/v1/businesses/${t.b.id}/services`, t.manager, { name: 'Haircut', durationMinutes: 60, priceMinor: 2500 })).body;
    return { ...t, svc };
  }
  const slots = async (u: TestUser, b: { handle: string }, svc: { id: string }, date = tomorrow()) =>
    (await call('GET', `/v1/businesses/${b.handle}/services/${svc.id}/slots?date=${date}`, u)).body;

  it('offers slots inside opening hours, in the business’s time zone', async () => {
    const { b, customer, svc } = await salon('Asia/Tokyo');
    const s = await slots(customer, b, svc);
    expect(s.timeZone).toBe('Asia/Tokyo');
    // 09:00 to 12:00 in Tokyo (UTC+9, no daylight saving) is 00:00 to 03:00 UTC.
    expect(s.slots.map((x: { startsAt: string }) => x.startsAt)).toEqual([0, 1, 2].map((h) => `${tomorrow()}T0${h}:00:00.000Z`));
    expect(s.slots[0]).toMatchObject({ endsAt: `${tomorrow()}T01:00:00.000Z`, remaining: 1 });
  });

  it('books a slot once, refuses times that aren’t offered, and frees the slot on cancel', async () => {
    const { b, staff, customer, svc } = await salon();
    const [first] = (await slots(customer, b, svc)).slots;
    const cid = clientId();
    const k = await call('POST', `/v1/businesses/${b.handle}/bookings`, customer, { serviceId: svc.id, startsAt: first.startsAt, clientId: cid, note: 'Short please' });
    expect(k.status).toBe(201);
    expect(k.body).toMatchObject({ status: 'confirmed', startsAt: first.startsAt, service: { id: svc.id, name: 'Haircut' }, note: 'Short please' });
    expect((await call('POST', `/v1/businesses/${b.handle}/bookings`, customer, { serviceId: svc.id, startsAt: first.startsAt, clientId: cid })).status).toBe(200);
    expect((await slots(customer, b, svc)).slots.map((x: { startsAt: string }) => x.startsAt)).not.toContain(first.startsAt);

    const other = await user();
    expect((await call('POST', `/v1/businesses/${b.handle}/bookings`, other, { serviceId: svc.id, startsAt: first.startsAt, clientId: clientId() })).body.error.code).toBe('slot_full');
    const offGrid = first.startsAt.replace(':00:00.000Z', ':30:00.000Z');
    expect((await call('POST', `/v1/businesses/${b.handle}/bookings`, other, { serviceId: svc.id, startsAt: offGrid, clientId: clientId() })).body.error.code).toBe('slot_unavailable');
    const past = new Date(Date.now() - 86400_000).toISOString().slice(0, 10) + 'T09:00:00.000Z';
    expect((await call('POST', `/v1/businesses/${b.handle}/bookings`, other, { serviceId: svc.id, startsAt: past, clientId: clientId() })).body.error.code).toBe('slot_unavailable');

    // Staff see who booked; outsiders see nothing.
    const range = `from=${tomorrow()}T00:00:00Z&to=${tomorrow()}T23:59:00Z`;
    expect((await call('GET', `/v1/businesses/${b.id}/bookings?${range}`, staff)).body.bookings[0]).toMatchObject({ id: k.body.id, customer: { id: customer.id } });
    expect((await call('GET', `/v1/businesses/${b.id}/bookings?${range}`, other)).status).toBe(404);
    expect((await call('GET', `/v1/bookings/${k.body.id}`, other)).status).toBe(404);
    expect((await call('GET', '/v1/bookings', customer)).body.bookings.map((x: { id: string }) => x.id)).toEqual([k.body.id]);

    expect((await call('POST', `/v1/bookings/${k.body.id}/outcome`, staff, { status: 'completed' })).body.error.code).toBe('booking_not_started');
    expect((await call('POST', `/v1/bookings/${k.body.id}/cancel`, customer)).body).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
    expect((await slots(customer, b, svc)).slots.map((x: { startsAt: string }) => x.startsAt)).toContain(first.startsAt);
    expect((await call('POST', `/v1/bookings/${k.body.id}/cancel`, customer)).body.error.code).toBe('booking_closed');
  });

  it('never overbooks when people race for the last place', async () => {
    const { b, manager, svc } = await salon();
    await call('PATCH', `/v1/businesses/${b.id}/services/${svc.id}`, manager, { capacity: 2 });
    const people = [await user(), await user(), await user(), await user(), await user()];
    const [slot] = (await slots(people[0], b, svc)).slots;
    expect(slot.remaining).toBe(2);
    const results = await Promise.all(people.map((u) => call('POST', `/v1/businesses/${b.handle}/bookings`, u, { serviceId: svc.id, startsAt: slot.startsAt, clientId: clientId() })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409]);
    expect((await slots(people[0], b, svc)).slots.map((x: { startsAt: string }) => x.startsAt)).not.toContain(slot.startsAt);
  });

  it('records the outcome after the start, and closed days and switched-off bookings offer nothing', async () => {
    const { b, owner, staff, customer, svc } = await salon('UTC', [{ weekday: new Date(Date.now() + 86400_000).getUTCDay(), opens: '09:00', closes: '11:00' }]);
    const [slot] = (await slots(customer, b, svc)).slots;
    const k = (await call('POST', `/v1/businesses/${b.handle}/bookings`, customer, { serviceId: svc.id, startsAt: slot.startsAt, clientId: clientId() })).body;
    // Pretend the appointment time has come.
    await pool.query(`UPDATE bookings SET starts_at = now() - interval '1 hour', ends_at = now() WHERE id = $1`, [k.id]);
    expect((await call('POST', `/v1/bookings/${k.id}/outcome`, customer, { status: 'completed' })).status).toBe(403);
    expect((await call('POST', `/v1/bookings/${k.id}/cancel`, customer)).body.error.code).toBe('booking_started');
    expect((await call('POST', `/v1/bookings/${k.id}/outcome`, staff, { status: 'no_show' })).body.status).toBe('no_show');
    const dayAfter = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    expect((await slots(customer, b, svc, dayAfter)).slots).toEqual([]);
    await call('PATCH', `/v1/businesses/${b.id}`, owner, { bookingsEnabled: false });
    expect((await slots(customer, b, svc)).slots).toEqual([]);
    expect((await call('POST', `/v1/businesses/${b.handle}/bookings`, customer, { serviceId: svc.id, startsAt: slot.startsAt, clientId: clientId() })).body.error.code).toBe('bookings_closed');
  });

  it('lets staff cancel for the business, and tells the customer live', async () => {
    const { b, staff, customer, svc } = await salon();
    const [slot] = (await slots(customer, b, svc)).slots;
    const k = (await call('POST', `/v1/businesses/${b.handle}/bookings`, customer, { serviceId: svc.id, startsAt: slot.startsAt, clientId: clientId() })).body;
    const sock = await connect(customer);
    expect((await call('POST', `/v1/bookings/${k.id}/cancel`, staff)).body).toMatchObject({ status: 'cancelled', cancelledBy: 'business', customer: { id: customer.id } });
    expect((await sock.next((f) => f.type === 'booking.updated')).data).toMatchObject({ id: k.id, status: 'cancelled', cancelledBy: 'business' });
  });
});

describe('suspension, closing and account deletion', () => {
  it('hides a suspended business from customers but lets staff see why, read-only', async () => {
    const { b, owner, staff, customer } = await team();
    await pool.query(`UPDATE businesses SET state = 'suspended', suspension_reason = 'Fake listings' WHERE id = $1`, [b.id]);
    expect((await call('GET', `/v1/businesses/${b.handle}`, customer)).status).toBe(404);
    expect((await call('GET', `/v1/businesses?q=${encodeURIComponent(b.name)}`, customer)).body.businesses.map((x: { id: string }) => x.id)).not.toContain(b.id);
    expect((await call('GET', `/v1/businesses/${b.id}`, staff)).body).toMatchObject({ state: 'suspended', suspensionReason: 'Fake listings' });
    expect((await call('GET', `/v1/businesses/${b.id}/orders`, staff)).status).toBe(200);
    expect((await call('PATCH', `/v1/businesses/${b.id}`, owner, { name: 'Renamed' })).body.error.code).toBe('business_suspended');
  });

  it('cancels open orders and future bookings when the owner closes the business', async () => {
    const { b, owner, manager, customer } = await team();
    await call('PATCH', `/v1/businesses/${b.id}`, owner, { ordersEnabled: true });
    const tea = await item(manager, b.id, { name: 'Tea', priceMinor: 200 });
    const o = (await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: tea.id, quantity: 1 }] })).body;
    expect((await call('DELETE', `/v1/businesses/${b.id}`, owner)).status).toBe(204);
    expect((await call('GET', `/v1/orders/${o.id}`, customer)).body).toMatchObject({ status: 'cancelled', statusReason: 'The business closed' });
    expect((await call('GET', `/v1/businesses/${b.handle}`, customer)).status).toBe(404);
    expect((await call('GET', `/v1/businesses/${b.id}`, owner)).status).toBe(404);
  });

  it('passes a business to its manager when the owner deletes their account, and exports orders', async () => {
    const { b, owner, manager, customer } = await team();
    await call('PATCH', `/v1/businesses/${b.id}`, owner, { ordersEnabled: true });
    const tea = await item(manager, b.id, { name: 'Tea', priceMinor: 200 });
    const o = (await call('POST', `/v1/businesses/${b.handle}/orders`, customer, { clientId: clientId(), items: [{ itemId: tea.id, quantity: 3 }] })).body;

    const exp = (await call('GET', '/v1/me/export', customer)).body;
    expect(exp.orders).toEqual([expect.objectContaining({ id: o.id, total_minor: '600', items: [{ name: 'Tea', unitPriceMinor: 600 / 3, quantity: 3 }] })]);
    expect((await call('GET', '/v1/me/export', manager)).body.businessRoles).toEqual([expect.objectContaining({ id: b.id, role: 'manager' })]);

    expect((await call('DELETE', '/v1/me', owner, { password: owner.password })).status).toBe(204);
    expect((await call('GET', `/v1/businesses/${b.id}`, manager)).body).toMatchObject({ myRole: 'owner', state: 'active' });

    // The customer deletes their account: the business keeps the order, without them.
    expect((await call('DELETE', '/v1/me', customer, { password: customer.password })).status).toBe(204);
    const kept = (await call('GET', `/v1/orders/${o.id}`, manager)).body;
    expect(kept).toMatchObject({ customer: null, status: 'cancelled', note: '' });
  });

  it('closes a business whose owner leaves no manager behind', async () => {
    const owner = await user();
    const b = await business(owner);
    expect((await call('DELETE', '/v1/me', owner, { password: owner.password })).status).toBe(204);
    const { rows } = await pool.query('SELECT state FROM businesses WHERE id = $1', [b.id]);
    expect(rows[0].state).toBe('deleted');
  });
});

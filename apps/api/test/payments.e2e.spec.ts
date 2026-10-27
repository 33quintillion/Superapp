import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { grantPlatformRole } from '../src/admin/grant';
import { totp } from '../src/crypto/totp';
import { StripeSandbox } from '../src/dev/stripe-sandbox';
import { PaymentsService } from '../src/payments/payments.service';
import { signStripePayload } from '../src/payments/stripe';
import { clientId, nextIp, registerUser, req, startApp, TEST_ENV, TestContext, TestUser, uniqueUser } from './helpers';
import { Client, rawConnect } from './ws-client';

// Online payments end to end: the real API, Postgres and Redis, and a local stand-in for
// Stripe that signs its webhooks and enforces idempotency keys the way Stripe does. Covers
// payout accounts, paying for orders, refunds, webhook verification and deduplication,
// business plans, and the ledger that has to agree with all of it.
const KEY = 'sk_test_local_sandbox_key';
const SECRET = 'whsec_current_secret';
const OLD_SECRET = 'whsec_previous_secret';
const FEE_BPS = 500; // 5%

let ctx: TestContext;
let pool: Pool;
let stripe: StripeSandbox;
let base: string;
let payments: PaymentsService;
const sockets: Client[] = [];
beforeAll(async () => {
  stripe = new StripeSandbox({ secretKey: KEY, webhookSecret: SECRET });
  await stripe.start();
  ctx = await startApp({
    PAYMENTS_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: KEY,
    // Two secrets: the current one and one being rotated out.
    STRIPE_WEBHOOK_SECRET: `${SECRET},${OLD_SECRET}`,
    STRIPE_API_BASE: stripe.url,
    PAYMENTS_PLATFORM_FEE_BPS: String(FEE_BPS),
    PAYMENTS_SWEEP_INTERVAL_SECONDS: '0',
  });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  stripe.webhookUrl = `http://${base}/v1/payments/webhooks/stripe`;
  pool = new Pool({ connectionString: TEST_ENV.DATABASE_URL });
  payments = ctx.app.get(PaymentsService);
});
afterAll(async () => {
  for (const s of sockets) if (!s.closed) await s.close();
  await ctx.close();
  await stripe.stop();
  await pool.end();
});
beforeEach(() => {
  stripe.autoDeliver = true;
  stripe.refundStatus = 'succeeded';
});

const user = () => registerUser(ctx.app, 'pay');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function connect(u: TestUser) {
  const t = (await call('POST', '/v1/realtime/tickets', u)).body.ticket;
  const ws = await rawConnect(base, `?ticket=${t}`);
  if (typeof ws === 'number') throw new Error(`connect failed: ${ws}`);
  const c = new Client(ws);
  sockets.push(c);
  await c.next((f) => f.type === 'ready');
  return c;
}

let handles = 0;
/** A shop with a manager, a staff member, two items (bread has stock) and a customer. Payouts not set up. */
async function shop(currency = 'GBP') {
  handles += 1;
  const [owner, manager, staff, customer] = [await user(), await user(), await user(), await user()];
  const b = (
    await call('POST', '/v1/businesses', owner, { handle: `pay-${process.pid % 10000}-${handles}`, name: `Bakery ${handles}`, category: 'food', timeZone: 'UTC', currency })
  ).body;
  await call('PATCH', `/v1/businesses/${b.id}`, owner, { ordersEnabled: true });
  for (const [u, role] of [
    [manager, 'manager'],
    [staff, 'staff'],
  ] as const) {
    await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: u.username, role });
    await call('POST', `/v1/businesses/${b.id}/staff/accept`, u);
  }
  const bread = (await call('POST', `/v1/businesses/${b.id}/items`, owner, { name: 'Sourdough', priceMinor: 450, stock: 5 })).body;
  const cake = (await call('POST', `/v1/businesses/${b.id}/items`, owner, { name: 'Lemon cake', priceMinor: 1275 })).body;
  const free = (await call('POST', `/v1/businesses/${b.id}/items`, owner, { name: 'Free sample', priceMinor: 0 })).body;
  return { b, owner, manager, staff, customer, bread, cake, free };
}

/** The owner finishes the provider's onboarding, so the shop can take payment online. */
async function payouts(s: Awaited<ReturnType<typeof shop>>) {
  const r = await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'GB' });
  expect(r.status).toBe(200);
  const acct = new URL(r.body.url).pathname.split('/').pop()!;
  await stripe.completeOnboarding(acct);
  return acct;
}

async function readyShop() {
  const s = await shop();
  const acct = await payouts(s);
  return { ...s, acct };
}

const order = (s: { b: { handle: string }; customer: TestUser }, items: { itemId: string; quantity: number }[], payment = 'online', id = clientId()) =>
  call('POST', `/v1/businesses/${s.b.handle}/orders`, s.customer, { clientId: id, items, payment });

/** Places an online order, opens its checkout, and pays. */
async function paidOrder(s: Awaited<ReturnType<typeof readyShop>>, items = [{ itemId: s.cake.id, quantity: 2 }]) {
  const o = (await order(s, items)).body;
  const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
  await stripe.pay(sessionOf(url));
  return (await call('GET', `/v1/orders/${o.id}`, s.customer)).body;
}

const sessionOf = (url: string) => new URL(url).pathname.split('/').pop()!;

async function ledgerFor(paymentId: string) {
  const { rows } = await pool.query(
    `SELECT t.kind, e.account, e.amount_minor::int AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
      WHERE t.payment_id = $1 ORDER BY t.created_at, e.id`,
    [paymentId],
  );
  return rows as { kind: string; account: string; amount: number }[];
}

async function paymentOf(orderId: string) {
  return (await pool.query('SELECT * FROM payments WHERE order_id = $1', [orderId])).rows[0];
}

const stock = async (s: { b: { id: string }; owner: TestUser }, itemId: string) =>
  (await call('GET', `/v1/businesses/${s.b.id}/items?all=true`, s.owner)).body.items.find((i: { id: string }) => i.id === itemId).stock;

describe('payout accounts', () => {
  it('lets only the owner set up payouts, and turns on online payment once the provider says so', async () => {
    const s = await shop();
    expect((await call('GET', `/v1/businesses/${s.b.handle}`, s.customer)).body.payments).toEqual({ online: false, inPerson: true });
    expect((await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.manager, { country: 'GB' })).status).toBe(403);
    expect((await call('GET', `/v1/businesses/${s.b.id}/payments/account`, s.staff)).status).toBe(403);
    expect((await call('GET', `/v1/businesses/${s.b.id}/payments/account`, s.customer)).status).toBe(404);
    expect((await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'gb' })).status).toBe(400);

    const r = await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'GB' });
    expect(r.body.account).toMatchObject({ connected: true, chargesEnabled: false, onlinePayments: false, country: 'GB' });
    // Asking again continues the same account rather than making another.
    const again = await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'GB' });
    expect(new URL(again.body.url).pathname).toBe(new URL(r.body.url).pathname);
    expect(stripe.requests.filter((q) => q.path === '/v1/accounts' && q.params.metadata?.business_id === s.b.id)).toHaveLength(1);
    expect((await order(s, [{ itemId: s.cake.id, quantity: 1 }])).body.error.code).toBe('online_payments_unavailable');

    await stripe.completeOnboarding(new URL(r.body.url).pathname.split('/').pop()!);
    expect((await call('GET', `/v1/businesses/${s.b.id}/payments/account`, s.manager)).body).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, onlinePayments: true });
    expect((await call('GET', `/v1/businesses/${s.b.handle}`, s.customer)).body.payments).toEqual({ online: true, inPerson: true });
  });

  it('reads the status from the provider when a webhook was missed', async () => {
    const s = await shop();
    const r = await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'GB' });
    stripe.autoDeliver = false;
    await stripe.completeOnboarding(new URL(r.body.url).pathname.split('/').pop()!);
    expect((await call('GET', `/v1/businesses/${s.b.handle}`, s.customer)).body.payments.online).toBe(false);
    expect((await call('GET', `/v1/businesses/${s.b.id}/payments/account`, s.owner)).body.onlinePayments).toBe(true);
    expect((await call('GET', `/v1/businesses/${s.b.handle}`, s.customer)).body.payments.online).toBe(true);
  });

  it('only stops payment at pickup once online payment works', async () => {
    const s = await shop();
    expect((await call('PATCH', `/v1/businesses/${s.b.id}`, s.owner, { inPersonPayments: false })).body.error.code).toBe('online_payments_unavailable');
    await payouts(s);
    expect((await call('PATCH', `/v1/businesses/${s.b.id}`, s.owner, { inPersonPayments: false })).body.payments).toEqual({ online: true, inPerson: false });
    expect((await order(s, [{ itemId: s.cake.id, quantity: 1 }], 'pay_in_person')).body.error.code).toBe('in_person_not_accepted');
    expect((await order(s, [{ itemId: s.cake.id, quantity: 1 }], 'online')).status).toBe(201);
  });
});

describe('paying for an order online', () => {
  it('holds the order until it is paid, then hands it to the shop and records the money', async () => {
    const s = await readyShop();
    const shopSocket = await connect(s.staff);
    const customerSocket = await connect(s.customer);
    const placed = await order(s, [
      { itemId: s.bread.id, quantity: 2 },
      { itemId: s.cake.id, quantity: 1 },
    ]);
    expect(placed.status).toBe(201);
    const o = placed.body;
    expect(o).toMatchObject({ status: 'pending_payment', payment: 'online', paymentStatus: 'unpaid', totalMinor: 2 * 450 + 1275 });
    // Stock is held while the customer pays; the shop doesn't see the order yet.
    expect(await stock(s, s.bread.id)).toBe(3);
    expect(await shopSocket.receives((f) => f.type === 'business.order.created')).toBe(false);
    expect((await call('GET', `/v1/businesses/${s.b.id}/orders`, s.staff)).body.orders).toEqual([]);
    expect((await call('POST', `/v1/orders/${o.id}/status`, s.staff, { status: 'accepted' })).body.error.code).toBe('invalid_transition');

    const co = await call('POST', `/v1/orders/${o.id}/checkout`, s.customer);
    expect(co.status).toBe(200);
    expect(co.body.url).toMatch(new RegExp(`^${stripe.url}/checkout/cs_test_`));
    // The hosted checkout charges the catalogue prices, pays the shop's account, and keeps our fee.
    const session = stripe.sessions.get(sessionOf(co.body.url))!;
    expect(session.line_items).toHaveLength(2);
    expect(session.line_items).toEqual(
      expect.arrayContaining([
        { quantity: '2', price_data: { currency: 'gbp', unit_amount: '450', product_data: { name: 'Sourdough' } } },
        { quantity: '1', price_data: { currency: 'gbp', unit_amount: '1275', product_data: { name: 'Lemon cake' } } },
      ]),
    );
    expect(session.payment_intent_data).toMatchObject({ application_fee_amount: String(Math.floor((2175 * FEE_BPS) / 10000)), transfer_data: { destination: s.acct } });
    expect((await call('POST', `/v1/orders/${o.id}/checkout`, await user())).status).toBe(404);
    // Asking again gives the same link.
    expect((await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body.url).toBe(co.body.url);

    await stripe.pay(session.id);
    expect((await shopSocket.next((f) => f.type === 'business.order.created')).data).toMatchObject({ id: o.id, status: 'placed', paymentStatus: 'paid' });
    expect((await customerSocket.next((f) => f.type === 'order.updated' && (f.data as { status: string }).status === 'placed')).data).toMatchObject({ paymentStatus: 'paid' });
    expect((await call('GET', `/v1/businesses/${s.b.id}/orders`, s.staff)).body.orders.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body.error.code).toBe('already_paid');

    const p = await paymentOf(o.id);
    const fee = Math.floor((2175 * FEE_BPS) / 10000);
    expect(await ledgerFor(p.id)).toEqual([
      { kind: 'payment', account: 'external:customers', amount: -2175 },
      { kind: 'payment', account: `business:${s.b.id}:sales`, amount: 2175 - fee },
      { kind: 'payment', account: 'platform:fees', amount: fee },
    ]);
    const detail = (await call('GET', `/v1/orders/${o.id}/payment`, s.manager)).body.payment;
    expect(detail).toMatchObject({ status: 'paid', amountMinor: 2175, refundableMinor: 2175, feeMinor: fee, currency: 'GBP', refunds: [] });
    expect((await call('GET', '/v1/me/payments', s.customer)).body.payments).toEqual([expect.objectContaining({ orderId: o.id, status: 'paid', business: expect.objectContaining({ id: s.b.id }) })]);
  });

  it('creates one checkout even when the provider times out and the customer tries again', async () => {
    const s = await readyShop();
    const o = (await order(s, [{ itemId: s.cake.id, quantity: 1 }])).body;
    stripe.failNext(/^POST \/v1\/checkout\/sessions$/, 500);
    const first = await call('POST', `/v1/orders/${o.id}/checkout`, s.customer);
    expect(first.status).toBe(502);
    expect(first.body.error.code).toBe('payment_provider_unavailable');
    const second = await call('POST', `/v1/orders/${o.id}/checkout`, s.customer);
    expect(second.status).toBe(200);
    const tries = stripe.requests.filter((q) => q.path === '/v1/checkout/sessions' && q.params.metadata?.order_id === o.id);
    expect(tries).toHaveLength(2);
    expect(tries[0]!.idempotencyKey).toBeDefined();
    expect(tries[1]!.idempotencyKey).toBe(tries[0]!.idempotencyKey);
    expect([...stripe.sessions.values()].filter((x) => x.metadata.order_id === o.id)).toHaveLength(1);
  });

  it('is safe to retry placing the order, and refuses what can’t be paid online', async () => {
    const s = await readyShop();
    const id = clientId();
    const a = await order(s, [{ itemId: s.bread.id, quantity: 1 }], 'online', id);
    const b = await order(s, [{ itemId: s.bread.id, quantity: 1 }], 'online', id);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [a.body.id])).rows[0].n).toBe(1);
    expect(await stock(s, s.bread.id)).toBe(4);
    expect((await order(s, [{ itemId: s.free.id, quantity: 1 }])).body.error.code).toBe('nothing_to_pay');
    expect((await order(s, [{ itemId: s.cake.id, quantity: 1 }], 'card' as string)).status).toBe(400);
    // Paying at pickup still works as before, with no payment record.
    const inPerson = (await order(s, [{ itemId: s.cake.id, quantity: 1 }], 'pay_in_person')).body;
    expect(inPerson).toMatchObject({ status: 'placed', payment: 'pay_in_person', paymentStatus: null });
    expect((await call('POST', `/v1/orders/${inPerson.id}/checkout`, s.customer)).body.error.code).toBe('not_online');
  });

  it('cancels the order and gives the stock back when the checkout runs out of time', async () => {
    const s = await readyShop();
    const o = (await order(s, [{ itemId: s.bread.id, quantity: 3 }])).body;
    const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
    expect(await stock(s, s.bread.id)).toBe(2);
    // Stripe expires the session at its expires_at and tells us.
    await stripe.deliver({
      id: `evt_exp_${o.id}`,
      type: 'checkout.session.expired',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { ...stripe.sessions.get(sessionOf(url)), status: 'expired' } },
    });
    expect((await call('GET', `/v1/orders/${o.id}`, s.customer)).body).toMatchObject({ status: 'cancelled', paymentStatus: 'cancelled', statusReason: 'Payment wasn’t completed in time' });
    expect(await stock(s, s.bread.id)).toBe(5);
    expect(await ledgerFor((await paymentOf(o.id)).id)).toEqual([]);
    expect((await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body.error.code).toBe('payment_closed');
  });

  it('closes the checkout when the customer cancels before paying', async () => {
    const s = await readyShop();
    const o = (await order(s, [{ itemId: s.bread.id, quantity: 1 }])).body;
    const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
    expect((await call('POST', `/v1/orders/${o.id}/cancel`, s.customer)).body).toMatchObject({ status: 'cancelled', paymentStatus: 'cancelled' });
    expect(stripe.sessions.get(sessionOf(url))!.status).toBe('expired');
    expect(await stock(s, s.bread.id)).toBe(5);
  });

  it('refunds a payment that arrives after the order was closed', async () => {
    const s = await readyShop();
    const o = (await order(s, [{ itemId: s.cake.id, quantity: 1 }])).body;
    const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
    // The customer cancels, but the provider can't be reached to close the checkout...
    stripe.failNext(/\/expire$/, 503);
    expect((await call('POST', `/v1/orders/${o.id}/cancel`, s.customer)).body.status).toBe('cancelled');
    // ...and they pay in the tab that was still open.
    await stripe.pay(sessionOf(url));
    const after = (await call('GET', `/v1/orders/${o.id}`, s.customer)).body;
    expect(after).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded', refundedMinor: 1275 });
    const p = await paymentOf(o.id);
    expect((await ledgerFor(p.id)).filter((e) => e.account === 'external:customers')).toEqual([
      { kind: 'payment', account: 'external:customers', amount: -1275 },
      { kind: 'refund', account: 'external:customers', amount: 1275 },
    ]);
    expect(stripe.requests.find((q) => q.path === '/v1/refunds' && q.params.payment_intent === p.provider_payment_id)?.params).toMatchObject({ reverse_transfer: 'true', refund_application_fee: 'true' });
  });

  it('tidies up when webhooks are lost: the sweep asks the provider how each checkout ended', async () => {
    const s = await readyShop();
    const paid = (await order(s, [{ itemId: s.cake.id, quantity: 1 }])).body;
    const abandoned = (await order(s, [{ itemId: s.bread.id, quantity: 2 }])).body;
    const never = (await order(s, [{ itemId: s.bread.id, quantity: 1 }])).body;
    const paidUrl = (await call('POST', `/v1/orders/${paid.id}/checkout`, s.customer)).body.url;
    await call('POST', `/v1/orders/${abandoned.id}/checkout`, s.customer);
    stripe.autoDeliver = false;
    await stripe.pay(sessionOf(paidUrl));
    // Time runs out for all three (one never even opened its checkout).
    await pool.query(`UPDATE payments SET checkout_expires_at = now() - interval '5 minutes', created_at = now() - interval '2 hours' WHERE order_id = ANY($1)`, [[paid.id, abandoned.id, never.id]]);
    await payments.sweep();
    const status = async (id: string) => (await call('GET', `/v1/orders/${id}`, s.customer)).body;
    expect(await status(paid.id)).toMatchObject({ status: 'placed', paymentStatus: 'paid' });
    expect(await status(abandoned.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'cancelled' });
    expect(await status(never.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'cancelled' });
    expect(await stock(s, s.bread.id)).toBe(5);
    // When the lost webhooks finally arrive they change nothing.
    stripe.autoDeliver = true;
    for (const e of stripe.events.filter((x) => x.data.object.metadata?.order_id === paid.id)) expect(await stripe.deliver(e)).toBe(200);
    expect((await ledgerFor((await paymentOf(paid.id)).id)).filter((e) => e.kind === 'payment')).toHaveLength(3);
  });
});

describe('webhooks', () => {
  async function pendingOrderEvent() {
    const s = await readyShop();
    const o = (await order(s, [{ itemId: s.cake.id, quantity: 1 }])).body;
    const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
    stripe.autoDeliver = false;
    await stripe.pay(sessionOf(url));
    stripe.autoDeliver = true;
    const event = stripe.events.filter((e) => e.type === 'checkout.session.completed' && e.data.object.metadata?.order_id === o.id).pop()!;
    return { s, o, event };
  }
  const orderStatus = async (s: { customer: TestUser }, id: string) => (await call('GET', `/v1/orders/${id}`, s.customer)).body.status;

  it('rejects events that aren’t signed by the provider, and changes nothing', async () => {
    const { s, o, event } = await pendingOrderEvent();
    const body = JSON.stringify(event);
    expect(await stripe.deliver(event, { signature: null })).toBe(400);
    expect(await stripe.deliver(event, { secret: 'whsec_someone_else' })).toBe(400);
    expect(await stripe.deliver(event, { signature: 't=123,v1=nothex' })).toBe(400);
    // A body changed after signing.
    const tampered = body.replace('"payment_status":"paid"', '"payment_status":"paid","amount_total":1');
    expect(await stripe.deliver(event, { body: tampered, signature: signStripePayload(body, SECRET) })).toBe(400);
    // A correctly signed request replayed later than the tolerance.
    expect(await stripe.deliver(event, { now: Date.now() - 10 * 60_000 })).toBe(400);
    const res = await fetch(stripe.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, SECRET) }, body });
    expect(res.status).toBe(200);
    const bad = await fetch(stripe.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_signature');
    expect(await orderStatus(s, o.id)).toBe('placed');
  });

  it('accepts the previous secret while it is being rotated out', async () => {
    const { s, o, event } = await pendingOrderEvent();
    expect(await stripe.deliver(event, { secret: OLD_SECRET })).toBe(200);
    expect(await orderStatus(s, o.id)).toBe('placed');
  });

  it('applies a redelivered event once, even when copies arrive together', async () => {
    const { s, o, event } = await pendingOrderEvent();
    const shopSocket = await connect(s.staff);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(stripe.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(JSON.stringify(event), SECRET) }, body: JSON.stringify(event) }).then((r) => r.json() as Promise<{ duplicate: boolean }>),
      ),
    );
    expect(results.filter((r) => r.duplicate === false)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate === true)).toHaveLength(4);
    expect(await stripe.deliver(event)).toBe(200);
    await shopSocket.next((f) => f.type === 'business.order.created');
    expect(await shopSocket.receives((f) => f.type === 'business.order.created')).toBe(false);
    expect(await ledgerFor((await paymentOf(o.id)).id)).toHaveLength(3);
    expect((await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [event.id])).rows[0].n).toBe(1);
  });

  it('refuses events from the other mode, and acknowledges types it doesn’t use', async () => {
    const { s, o, event } = await pendingOrderEvent();
    expect(await stripe.deliver({ ...event, id: `${event.id}_live`, livemode: true })).toBe(400);
    expect(await orderStatus(s, o.id)).toBe('pending_payment');
    expect(await stripe.deliver({ id: `evt_other_${o.id}`, type: 'customer.created', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'cus_x' } } })).toBe(200);
    expect((await pool.query('SELECT type FROM payment_events WHERE event_id = $1', [`evt_other_${o.id}`])).rows).toEqual([{ type: 'customer.created' }]);
  });
});

describe('refunds', () => {
  it('lets managers refund part or all of a paid order, once per request, never more than was paid', async () => {
    const s = await readyShop();
    const o = await paidOrder(s); // 2 × 12.75 = 25.50
    const refund = (u: TestUser, body: Record<string, unknown>) => call('POST', `/v1/orders/${o.id}/refunds`, u, { clientId: clientId(), ...body });
    expect((await refund(s.staff, { amountMinor: 100 })).status).toBe(403);
    expect((await refund(s.customer, { amountMinor: 100 })).status).toBe(403);
    expect((await refund(await user(), { amountMinor: 100 })).status).toBe(404);

    const id = clientId();
    const first = await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: id, amountMinor: 1000, reason: 'Cake was squashed' });
    expect(first.status).toBe(201);
    expect(first.body.refund).toMatchObject({ amountMinor: 1000, status: 'succeeded', origin: 'staff', reason: 'Cake was squashed' });
    expect(first.body.payment).toMatchObject({ status: 'partially_refunded', refundedMinor: 1000, refundableMinor: 1550 });
    // The same request again (a double click, a retry) does nothing new.
    const again = await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: id, amountMinor: 1000, reason: 'Cake was squashed' });
    expect(again.body.refund.id).toBe(first.body.refund.id);
    expect(stripe.requests.filter((q) => q.path === '/v1/refunds' && q.params.metadata?.payment_id === first.body.payment.id)).toHaveLength(1);

    const tooMuch = await refund(s.manager, { amountMinor: 1551 });
    expect(tooMuch.body.error).toMatchObject({ code: 'refund_too_large', details: { refundableMinor: 1550 } });
    // No amount means everything that is left.
    expect((await refund(s.owner, { reason: 'Closing early' })).body.payment).toMatchObject({ status: 'refunded', refundableMinor: 0 });
    expect((await refund(s.owner, {})).body.error.code).toBe('refund_too_large');
    expect((await call('GET', `/v1/orders/${o.id}`, s.customer)).body).toMatchObject({ paymentStatus: 'refunded', refundedMinor: 2550 });

    // The platform fee comes back in proportion, and in full by the last refund.
    const fee = Math.floor((2550 * FEE_BPS) / 10000);
    const entries = await ledgerFor(first.body.payment.id);
    const sum = (account: string) => entries.filter((e) => e.account === account).reduce((t, e) => t + e.amount, 0);
    expect(sum('external:customers')).toBe(0);
    expect(sum('platform:fees')).toBe(0);
    expect(sum(`business:${s.b.id}:sales`)).toBe(0);
    expect(entries.find((e) => e.kind === 'refund' && e.account === 'platform:fees')!.amount).toBe(-Math.floor((fee * 1000) / 2550));
  });

  it('refunds in full when the shop rejects or cancels a paid order', async () => {
    const s = await readyShop();
    const rejected = await paidOrder(s, [{ itemId: s.bread.id, quantity: 2 }]);
    expect(await stock(s, s.bread.id)).toBe(3);
    const r = await call('POST', `/v1/orders/${rejected.id}/status`, s.staff, { status: 'rejected', reason: 'Oven broke' });
    expect(r.body).toMatchObject({ status: 'rejected', paymentStatus: 'refunded', refundedMinor: 900 });
    expect(await stock(s, s.bread.id)).toBe(5);
    const cancelled = await paidOrder(s);
    await call('POST', `/v1/orders/${cancelled.id}/status`, s.staff, { status: 'accepted' });
    expect((await call('POST', `/v1/orders/${cancelled.id}/status`, s.staff, { status: 'cancelled' })).body.paymentStatus).toBe('refunded');
    const refunds = (await call('GET', `/v1/orders/${cancelled.id}/payment`, s.customer)).body.payment.refunds;
    expect(refunds).toEqual([expect.objectContaining({ origin: 'auto', status: 'succeeded', amountMinor: 2550 })]);
  });

  it('gives the amount back to refund again when the bank refuses a refund', async () => {
    const s = await readyShop();
    const o = await paidOrder(s);
    stripe.refundStatus = 'pending';
    const r = (await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: clientId(), amountMinor: 500 })).body;
    expect(r.refund.status).toBe('pending');
    expect(r.payment).toMatchObject({ refundedMinor: 500, refundableMinor: 2050 });
    const providerRefund = [...stripe.refunds.values()].find((x) => x.metadata.refund_id === r.refund.id)!;
    await stripe.settleRefund(providerRefund.id, 'failed');
    const after = (await call('GET', `/v1/orders/${o.id}/payment`, s.manager)).body.payment;
    expect(after).toMatchObject({ status: 'paid', refundedMinor: 0, refundableMinor: 2550, refunds: [expect.objectContaining({ status: 'failed' })] });
    expect((await ledgerFor(after.id)).filter((e) => e.kind === 'refund')).toEqual([]);

    const second = (await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: clientId(), amountMinor: 500 })).body;
    await stripe.settleRefund([...stripe.refunds.values()].find((x) => x.metadata.refund_id === second.refund.id)!.id, 'succeeded');
    expect((await call('GET', `/v1/orders/${o.id}/payment`, s.manager)).body.payment).toMatchObject({ status: 'partially_refunded', refundedMinor: 500 });
    expect((await ledgerFor(after.id)).filter((e) => e.kind === 'refund' && e.account === 'external:customers')).toEqual([{ kind: 'refund', account: 'external:customers', amount: 500 }]);
  });

  it('records refunds made in the provider’s dashboard', async () => {
    const s = await readyShop();
    const o = await paidOrder(s);
    const p = await paymentOf(o.id);
    await stripe.dashboardRefund(p.provider_payment_id, 550);
    const detail = (await call('GET', `/v1/orders/${o.id}/payment`, s.manager)).body.payment;
    expect(detail).toMatchObject({ status: 'partially_refunded', refundedMinor: 550, refunds: [expect.objectContaining({ origin: 'provider', status: 'succeeded', amountMinor: 550 })] });
    expect((await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: clientId(), amountMinor: 2001 })).body.error.code).toBe('refund_too_large');
  });

  it('retries a refund with the same key when the provider was down', async () => {
    const s = await readyShop();
    const o = await paidOrder(s);
    stripe.failNext(/^POST \/v1\/refunds$/, 503);
    const r = (await call('POST', `/v1/orders/${o.id}/refunds`, s.manager, { clientId: clientId(), amountMinor: 700 })).body;
    expect(r.refund.status).toBe('pending');
    await pool.query(`UPDATE refunds SET created_at = now() - interval '5 minutes' WHERE id = $1`, [r.refund.id]);
    await payments.sweep();
    expect((await call('GET', `/v1/orders/${o.id}/payment`, s.manager)).body.payment.refunds).toEqual([expect.objectContaining({ id: r.refund.id, status: 'succeeded' })]);
    const tries = stripe.requests.filter((q) => q.path === '/v1/refunds' && q.params.metadata?.refund_id === r.refund.id);
    expect(tries).toHaveLength(2);
    expect(tries[1]!.idempotencyKey).toBe(tries[0]!.idempotencyKey);
  });
});

describe('closing and leaving', () => {
  it('refunds open paid orders and ends the plan when a business closes', async () => {
    const s = await readyShop();
    const open = await paidOrder(s);
    const unpaid = (await order(s, [{ itemId: s.bread.id, quantity: 1 }])).body;
    await call('POST', `/v1/orders/${unpaid.id}/checkout`, s.customer);
    expect((await call('DELETE', `/v1/businesses/${s.b.id}`, s.owner)).status).toBe(204);
    const status = async (id: string) => (await pool.query('SELECT o.status, p.status AS pay, p.refunded_minor::int AS refunded FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1', [id])).rows[0];
    expect(await status(open.id)).toEqual({ status: 'cancelled', pay: 'succeeded', refunded: 2550 });
    expect(await status(unpaid.id)).toEqual({ status: 'cancelled', pay: 'cancelled', refunded: 0 });
  });

  it('refunds a customer’s paid orders when they delete their account, and keeps the record without them', async () => {
    const s = await readyShop();
    const o = await paidOrder(s);
    const exported = (await call('GET', '/v1/me/export', s.customer)).body;
    expect(exported.payments).toEqual([expect.objectContaining({ order_id: o.id, status: 'succeeded', amount_minor: '2550' })]);
    expect((await call('DELETE', '/v1/me', s.customer, { password: s.customer.password })).status).toBe(204);
    const p = await paymentOf(o.id);
    expect(p).toMatchObject({ payer_id: null, refunded_minor: '2550' });
  });
});

/** A new account with two-step on, made platform staff, signed in with a code. */
async function staffMember(role: 'admin' | 'moderator') {
  const u = uniqueUser('padm');
  const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
  const token = reg.body.accessToken;
  const { secret } = (await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token })).body;
  await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token, body: { code: totp(secret, Date.now() - 30_000) } });
  await grantPlatformRole(pool, u.email, role);
  const step1 = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password }, ip: nextIp() });
  const step2 = await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: step1.body.mfaToken, code: totp(secret) }, ip: nextIp() });
  return { id: '', token: step2.body.accessToken as string, sessionId: step2.body.sessionId as string, username: u.username, password: u.password };
}

describe('business plans', () => {
  let admin: TestUser;
  let plan: { id: string; code: string };
  beforeAll(async () => {
    admin = await staffMember('admin');
    const created = await call('POST', '/v1/admin/plans', admin, {
      code: `growth-${process.pid % 10000}`,
      name: 'Growth',
      description: 'More staff and a bigger catalogue',
      priceMinor: 1500,
      currency: 'GBP',
      interval: 'month',
      entitlements: ['staff.extra', 'catalogue.extra'],
    });
    expect(created.status).toBe(201);
    plan = created.body;
  });

  it('lets only admins make plans, and lists them once they go on sale', async () => {
    const mod = await staffMember('moderator');
    expect((await call('POST', '/v1/admin/plans', mod, { code: 'x1', name: 'X', priceMinor: 1, currency: 'GBP', interval: 'month', entitlements: ['staff.extra'] })).body.error.code).toBe('admin_only');
    expect((await call('POST', '/v1/admin/plans', admin, { code: 'bad', name: 'X', priceMinor: 1, currency: 'GBP', interval: 'month', entitlements: ['everything'] })).status).toBe(400);
    expect((await call('POST', '/v1/admin/plans', admin, { code: plan.code, name: 'Again', priceMinor: 1, currency: 'GBP', interval: 'month', entitlements: ['staff.extra'] })).body.error.code).toBe('plan_code_taken');
    const someone = await user();
    expect((await call('GET', '/v1/plans', someone)).body.plans.find((p: { id: string }) => p.id === plan.id)).toBeUndefined();
    expect((await call('POST', `/v1/admin/plans/${plan.id}/state`, admin, { state: 'active' })).body.state).toBe('active');
    expect((await call('GET', '/v1/plans', someone)).body.plans.find((p: { id: string }) => p.id === plan.id)).toMatchObject({ priceMinor: 1500, interval: 'month', entitlements: ['staff.extra', 'catalogue.extra'] });
    const price = [...stripe.prices.values()].find((p) => p.id === (stripe.requests.find((q) => q.path === '/v1/prices' && q.params.metadata?.plan_code === plan.code) && p.unit_amount === 1500 ? p.id : ''));
    expect(price).toMatchObject({ currency: 'gbp', recurring: { interval: 'month' } });
  });

  it('subscribes through hosted checkout, unlocks the plan’s limits, and records the income', async () => {
    const s = await shop();
    const sub = (u: TestUser) => call('POST', `/v1/businesses/${s.b.id}/subscription`, u, { planCode: plan.code, clientId: clientId() });
    expect((await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.manager)).body).toMatchObject({ subscription: null, limits: { staff: 10, catalogue: 500 } });
    expect((await sub(s.manager)).status).toBe(403);
    expect((await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: 'nope', clientId: clientId() })).status).toBe(404);
    const { url } = (await sub(s.owner)).body;
    await stripe.pay(sessionOf(url));
    const now = (await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.manager)).body;
    expect(now).toMatchObject({ subscription: { status: 'active', entitled: true, cancelAtPeriodEnd: false, plan: { code: plan.code } }, limits: { staff: 100, catalogue: 5000 } });
    expect(now.entitlements.sort()).toEqual(['catalogue.extra', 'staff.extra']);
    expect((await sub(s.owner)).body.error.code).toBe('already_subscribed');
    const income = await pool.query(
      `SELECT e.account, e.amount_minor::int AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN subscriptions s ON s.id = t.subscription_id WHERE s.business_id = $1 ORDER BY e.id`,
      [s.b.id],
    );
    expect(income.rows).toEqual([
      { account: 'external:customers', amount: -1500 },
      { account: 'platform:subscriptions', amount: 1500 },
    ]);
    const renewal = await stripe.renew([...stripe.subscriptions.values()].find((x) => x.metadata.business_id === s.b.id)!.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE provider_ref = $1', [renewal.id])).rows[0].n).toBe(1);
  });

  it('raises the staff limit only while the plan is paid for', async () => {
    const s = await shop();
    // Owner, manager and staff are 3 of the free 10.
    const extra = await Promise.all(Array.from({ length: 8 }, () => user()));
    for (const u of extra.slice(0, 7)) expect((await call('POST', `/v1/businesses/${s.b.id}/staff`, s.owner, { username: u.username, role: 'staff' })).status).toBe(201);
    expect((await call('POST', `/v1/businesses/${s.b.id}/staff`, s.owner, { username: extra[7]!.username, role: 'staff' })).body.error).toMatchObject({ code: 'staff_limit', details: { limit: 10 } });
    const { url } = (await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: plan.code, clientId: clientId() })).body;
    await stripe.pay(sessionOf(url));
    expect((await call('POST', `/v1/businesses/${s.b.id}/staff`, s.owner, { username: extra[7]!.username, role: 'staff' })).status).toBe(201);

    const providerSub = [...stripe.subscriptions.values()].find((x) => x.metadata.business_id === s.b.id)!;
    // Renewal fails: the provider retries for a while and the plan keeps working.
    await stripe.failRenewal(providerSub.id);
    expect((await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.owner)).body).toMatchObject({ subscription: { status: 'past_due', entitled: true }, limits: { staff: 100 } });
    // Cancel at the end of the period, change of mind, then cancel for good.
    expect((await call('DELETE', `/v1/businesses/${s.b.id}/subscription`, s.manager)).status).toBe(403);
    expect((await call('DELETE', `/v1/businesses/${s.b.id}/subscription`, s.owner)).body.subscription.cancelAtPeriodEnd).toBe(true);
    expect((await call('POST', `/v1/businesses/${s.b.id}/subscription/resume`, s.owner)).body.subscription.cancelAtPeriodEnd).toBe(false);
    await call('DELETE', `/v1/businesses/${s.b.id}/subscription`, s.owner);
    await stripe.endSubscription(providerSub.id);
    expect((await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.owner)).body).toMatchObject({ subscription: null, entitlements: [], limits: { staff: 10 } });
    const another = await user();
    expect((await call('POST', `/v1/businesses/${s.b.id}/staff`, s.owner, { username: another.username, role: 'staff' })).body.error.code).toBe('staff_limit');
    const portal = await call('POST', `/v1/businesses/${s.b.id}/billing-portal`, s.owner);
    expect(portal.body.url).toMatch(new RegExp(`^${stripe.url}/portal/cus_`));
  });

  it('ignores subscription events that arrive late, and a cancelled plan stays cancelled', async () => {
    const s = await shop();
    stripe.autoDeliver = false;
    const { url } = (await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: plan.code, clientId: clientId() })).body;
    await stripe.pay(sessionOf(url));
    const subId = [...stripe.subscriptions.values()].find((x) => x.metadata.business_id === s.b.id)!.id;
    const created = stripe.last('customer.subscription.created')!;
    const pastDue: Record<string, any> = { ...structuredClone(created), id: `${created.id}_pd`, type: 'customer.subscription.updated', created: created.created + 10 };
    pastDue.data.object.status = 'past_due';
    // The newer event arrives first; the older "active" one must not undo it.
    expect(await stripe.deliver(pastDue)).toBe(200);
    expect(await stripe.deliver(created)).toBe(200);
    expect(await stripe.deliver(stripe.last('checkout.session.completed')!)).toBe(200);
    const status = async () => (await pool.query('SELECT status FROM subscriptions WHERE provider_subscription_id = $1', [subId])).rows[0].status;
    expect(await status()).toBe('past_due');
    const deleted: Record<string, any> = { ...structuredClone(pastDue), id: `${created.id}_del`, type: 'customer.subscription.deleted', created: created.created + 20 };
    deleted.data.object.status = 'canceled';
    const revived: Record<string, any> = { ...structuredClone(pastDue), id: `${created.id}_rev`, created: created.created + 30 };
    revived.data.object.status = 'active';
    expect(await stripe.deliver(deleted)).toBe(200);
    expect(await stripe.deliver(revived)).toBe(200);
    expect(await status()).toBe('canceled');
  });

  it('ends a second subscription started from another tab', async () => {
    const s = await shop();
    const a = (await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: plan.code, clientId: clientId() })).body.url;
    const b = (await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: plan.code, clientId: clientId() })).body.url;
    await stripe.pay(sessionOf(a));
    await stripe.pay(sessionOf(b));
    const subs = [...stripe.subscriptions.values()].filter((x) => x.metadata.business_id === s.b.id);
    expect(subs.map((x) => x.status).sort()).toEqual(['active', 'canceled']);
    expect((await pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE business_id = $1 AND status <> 'canceled'`, [s.b.id])).rows[0].n).toBe(1);
  });
});

describe('the ledger', () => {
  it('refuses entries that don’t balance, and any change to past entries', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = (await client.query(`INSERT INTO ledger_transactions (kind, provider_ref, currency) VALUES ('payment', 'test_unbalanced', 'GBP') RETURNING id`)).rows[0];
      await client.query(`INSERT INTO ledger_entries (transaction_id, account, amount_minor) VALUES ($1, 'external:customers', -100), ($1, 'platform:fees', 99)`, [t.id]);
      await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      client.release();
    }
    await expect(pool.query(`UPDATE ledger_entries SET amount_minor = amount_minor * 2 WHERE id = (SELECT min(id) FROM ledger_entries)`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ledger_transactions WHERE id = (SELECT id FROM ledger_transactions LIMIT 1)`)).rejects.toThrow(/append-only/);
  });

  it('agrees with every payment and refund, and is only shown to admins', async () => {
    const admin = await staffMember('admin');
    const mod = await staffMember('moderator');
    expect((await call('GET', '/v1/admin/ledger', mod)).body.error.code).toBe('admin_only');
    expect((await call('GET', '/v1/admin/ledger', await user())).body.error.code).toBe('not_platform_staff');
    const l = (await call('GET', '/v1/admin/ledger', admin)).body;
    expect(l.check).toMatchObject({ ok: true, problems: [] });
    expect(l.check.transactions).toBeGreaterThan(10);
    // Everything in one currency nets to zero across accounts.
    const gbp = l.balances.filter((b: { currency: string }) => b.currency === 'GBP');
    expect(gbp.reduce((t: number, b: { balanceMinor: number }) => t + b.balanceMinor, 0)).toBe(0);
    const list = (await call('GET', '/v1/admin/payments?status=succeeded&limit=5', admin)).body;
    expect(list.payments).toHaveLength(5);
    expect(list.nextCursor).toEqual(expect.any(String));
  });
});

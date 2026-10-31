import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { grantPlatformRole } from '../src/admin/grant';
import { totp } from '../src/crypto/totp';
import { StripeSandbox } from '../src/dev/stripe-sandbox';
import { PaymentsService } from '../src/payments/payments.service';
import { clientId, nextIp, registerUser, req, startApp, TEST_ENV, TestContext, TestUser, uniqueUser } from './helpers';
import { Client, rawConnect } from './ws-client';

// The Stage 8 follow-ups, end to end against the local Stripe stand-in: deposits for
// bookings, disputes (chargebacks), changing plan in place, payouts, and checking the
// ledger against the provider's balance records.
const KEY = 'sk_test_local_sandbox_key';
const SECRET = 'whsec_more_secret';
const FEE_BPS = 1000; // 10%, so the fee's share is easy to see

let ctx: TestContext;
let pool: Pool;
let stripe: StripeSandbox;
let base: string;
let payments: PaymentsService;
const started = new Date();
const sockets: Client[] = [];
beforeAll(async () => {
  stripe = new StripeSandbox({ secretKey: KEY, webhookSecret: SECRET });
  await stripe.start();
  ctx = await startApp({
    PAYMENTS_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: KEY,
    STRIPE_WEBHOOK_SECRET: SECRET,
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

const user = () => registerUser(ctx.app, 'pmore');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });
const day = (plus: number) => new Date(Date.now() + plus * 86400_000).toISOString().slice(0, 10);
const allWeek = (opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens, closes }));
const sessionOf = (url: string) => new URL(url).pathname.split('/').pop()!;

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
/** A business taking orders and bookings, with a manager, a staff member and a customer. Payouts not set up. */
async function business() {
  handles += 1;
  const [owner, manager, staff, customer] = [await user(), await user(), await user(), await user()];
  // Payouts need a confirmed email; that flow has its own test in auth.e2e.
  await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [owner.id]);
  const b = (
    await call('POST', '/v1/businesses', owner, { handle: `pmore-${process.pid % 10000}-${handles}`, name: `Studio ${handles}`, category: 'beauty', timeZone: 'UTC', currency: 'GBP' })
  ).body;
  await call('PATCH', `/v1/businesses/${b.id}`, owner, { ordersEnabled: true, bookingsEnabled: true });
  await call('PUT', `/v1/businesses/${b.id}/hours`, owner, { hours: allWeek('09:00', '12:00') });
  for (const [u, role] of [
    [manager, 'manager'],
    [staff, 'staff'],
  ] as const) {
    await call('POST', `/v1/businesses/${b.id}/staff`, owner, { username: u.username, role });
    await call('POST', `/v1/businesses/${b.id}/staff/accept`, u);
  }
  const cake = (await call('POST', `/v1/businesses/${b.id}/items`, owner, { name: 'Gift card', priceMinor: 5000 })).body;
  return { b, owner, manager, staff, customer, cake };
}
type Biz = Awaited<ReturnType<typeof business>>;

async function payouts(s: Biz) {
  const r = await call('POST', `/v1/businesses/${s.b.id}/payments/account`, s.owner, { country: 'GB' });
  expect(r.status).toBe(200);
  const acct = sessionOf(r.body.url);
  await stripe.completeOnboarding(acct);
  return acct;
}

async function ready() {
  const s = await business();
  const acct = await payouts(s);
  return { ...s, acct };
}

/** A one-hour service with a deposit. */
async function service(s: Biz, deposit = 1000, freeCancelHours = 24, priceMinor = 4000) {
  const r = await call('POST', `/v1/businesses/${s.b.id}/services`, s.manager, { name: `Massage ${deposit}`, durationMinutes: 60, priceMinor, depositMinor: deposit, freeCancelHours });
  expect(r.status).toBe(201);
  return r.body as { id: string; depositMinor: number; freeCancelHours: number };
}

const slots = async (s: Biz, svc: { id: string }, date: string) =>
  (await call('GET', `/v1/businesses/${s.b.handle}/services/${svc.id}/slots?date=${date}`, s.customer)).body.slots as { startsAt: string; remaining: number }[];

async function book(s: Biz, svc: { id: string }, date = day(2), who = s.customer) {
  const [slot] = await slots(s, svc, date);
  return call('POST', `/v1/businesses/${s.b.handle}/bookings`, who, { serviceId: svc.id, startsAt: slot!.startsAt, clientId: clientId() });
}

/** Books and pays the deposit. */
async function paidBooking(s: Biz, svc: { id: string }, date = day(2)) {
  const k = (await book(s, svc, date)).body;
  const { url } = (await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body;
  await stripe.pay(sessionOf(url));
  return (await call('GET', `/v1/bookings/${k.id}`, s.customer)).body;
}

async function paidOrder(s: Biz) {
  const o = (await call('POST', `/v1/businesses/${s.b.handle}/orders`, s.customer, { clientId: clientId(), items: [{ itemId: s.cake.id, quantity: 1 }], payment: 'online' })).body;
  const { url } = (await call('POST', `/v1/orders/${o.id}/checkout`, s.customer)).body;
  await stripe.pay(sessionOf(url));
  const p = (await pool.query('SELECT * FROM payments WHERE order_id = $1', [o.id])).rows[0];
  return { order: o, payment: p };
}

async function ledgerFor(paymentId: string) {
  const { rows } = await pool.query(
    `SELECT t.kind, e.account, e.amount_minor::int AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
      WHERE t.payment_id = $1 ORDER BY t.created_at, e.id`,
    [paymentId],
  );
  return rows as { kind: string; account: string; amount: number }[];
}

const bookingPayment = async (bookingId: string) => (await pool.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId])).rows[0];
const staffBookings = async (s: Biz, date: string) =>
  (await call('GET', `/v1/businesses/${s.b.id}/bookings?from=${date}T00:00:00Z&to=${date}T23:59:00Z`, s.staff)).body.bookings.map((k: { id: string }) => k.id);

async function staffMember(role: 'admin' | 'moderator') {
  const u = uniqueUser('pmadm');
  const reg = await req(ctx.app, 'POST', '/v1/auth/register', { body: u, ip: nextIp() });
  const token = reg.body.accessToken;
  const { secret } = (await req(ctx.app, 'POST', '/v1/auth/mfa/setup', { token })).body;
  await req(ctx.app, 'POST', '/v1/auth/mfa/confirm', { token, body: { code: totp(secret, Date.now() - 30_000) } });
  await grantPlatformRole(pool, u.email, role);
  const step1 = await req(ctx.app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password }, ip: nextIp() });
  const step2 = await req(ctx.app, 'POST', '/v1/auth/login/mfa', { body: { mfaToken: step1.body.mfaToken, code: totp(secret) }, ip: nextIp() });
  return { id: '', token: step2.body.accessToken as string, sessionId: step2.body.sessionId as string, username: u.username, password: u.password };
}

describe('booking deposits', () => {
  it('asks for a deposit only once payouts work, and never more than the price', async () => {
    const s = await business();
    const make = (body: object) => call('POST', `/v1/businesses/${s.b.id}/services`, s.manager, { name: 'Facial', durationMinutes: 30, priceMinor: 3000, ...body });
    expect((await make({ depositMinor: 500 })).body.error.code).toBe('online_payments_unavailable');
    const free = (await make({})).body;
    expect(free).toMatchObject({ depositMinor: 0, freeCancelHours: 24 });
    await payouts(s);
    expect((await make({ depositMinor: 3001 })).status).toBe(400);
    expect((await make({ depositMinor: 3000, freeCancelHours: 169 })).status).toBe(400);
    expect((await make({ depositMinor: 3000, freeCancelHours: 48 })).body).toMatchObject({ depositMinor: 3000, freeCancelHours: 48 });
    // The price can't drop below the deposit.
    const svc = (await make({ depositMinor: 1000 })).body;
    expect((await call('PATCH', `/v1/businesses/${s.b.id}/services/${svc.id}`, s.manager, { priceMinor: 900 })).status).toBe(400);
    expect((await call('PATCH', `/v1/businesses/${s.b.id}/services/${svc.id}`, s.manager, { depositMinor: 1500 })).body.depositMinor).toBe(1500);
    expect((await call('PATCH', `/v1/businesses/${s.b.id}/services/${svc.id}`, s.staff, { depositMinor: 0 })).status).toBe(403);
    // A booking without a deposit is confirmed straight away, as before.
    const k = (await book(s, free)).body;
    expect(k).toMatchObject({ status: 'confirmed', deposit: null, priceMinor: 3000, currency: 'GBP' });
  });

  it('holds the place until the deposit is paid, then confirms it for staff and records the money', async () => {
    const s = await ready();
    const svc = await service(s, 1000);
    const staffSocket = await connect(s.staff);
    const r = await book(s, svc);
    expect(r.status).toBe(201);
    const k = r.body;
    expect(k).toMatchObject({ status: 'pending_payment', priceMinor: 4000, deposit: { amountMinor: 1000, status: 'unpaid', refundedMinor: 0 } });
    // The place is held: with capacity 1, that time is gone for others, but staff don't see it yet.
    expect((await slots(s, svc, day(2))).map((x) => x.startsAt)).not.toContain(k.startsAt);
    expect(await staffBookings(s, day(2))).toEqual([]);
    expect(await staffSocket.receives((f) => f.type === 'business.booking.created')).toBe(false);
    expect((await call('GET', '/v1/bookings', s.customer)).body.bookings.map((x: { id: string }) => x.id)).toContain(k.id);

    const co = await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer);
    expect(co.status).toBe(200);
    const session = stripe.sessions.get(sessionOf(co.body.url))!;
    expect(session.line_items).toEqual([{ quantity: '1', price_data: { currency: 'gbp', unit_amount: '1000', product_data: { name: expect.stringMatching(/^Deposit: Massage 1000, /) } } }]);
    expect(session.payment_intent_data).toMatchObject({ application_fee_amount: '100', transfer_data: { destination: s.acct }, metadata: { booking_id: k.id } });
    expect(session.success_url).toMatch(new RegExp(`/orders\\?booked=${k.id}$`));
    expect((await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body.url).toBe(co.body.url);
    expect((await call('POST', `/v1/bookings/${k.id}/checkout`, s.staff)).status).toBe(404);

    await stripe.pay(session.id);
    expect((await staffSocket.next((f) => f.type === 'business.booking.created')).data).toMatchObject({ id: k.id, status: 'confirmed', deposit: { status: 'paid' } });
    expect(await staffBookings(s, day(2))).toEqual([k.id]);
    expect((await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body.error.code).toBe('already_paid');
    const p = await bookingPayment(k.id);
    expect(await ledgerFor(p.id)).toEqual([
      { kind: 'payment', account: 'external:customers', amount: -1000 },
      { kind: 'payment', account: `business:${s.b.id}:sales`, amount: 900 },
      { kind: 'payment', account: 'platform:fees', amount: 100 },
    ]);
    expect((await call('GET', `/v1/bookings/${k.id}/payment`, s.manager)).body.payment).toMatchObject({ bookingId: k.id, orderId: null, status: 'paid', amountMinor: 1000, refunds: [], disputes: [] });
    expect((await call('GET', `/v1/bookings/${k.id}/payment`, await user())).status).toBe(404);
    expect((await call('GET', '/v1/me/payments', s.customer)).body.payments).toEqual([expect.objectContaining({ bookingId: k.id, status: 'paid' })]);
  });

  it('gives the place back when the deposit isn’t paid in time, or the customer gives up', async () => {
    const s = await ready();
    const svc = await service(s);
    const k = (await book(s, svc)).body;
    const { url } = (await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body;
    // The provider's checkout runs out.
    await fetch(`${stripe.url}/v1/checkout/sessions/${sessionOf(url)}/expire`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } });
    expect((await call('GET', `/v1/bookings/${k.id}`, s.customer)).body).toMatchObject({ status: 'cancelled', deposit: { status: 'cancelled' } });
    expect((await slots(s, svc, day(2))).map((x) => x.startsAt)).toContain(k.startsAt);
    expect((await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body.error.code).toBe('payment_closed');

    // Dropping it before paying closes the checkout.
    const k2 = (await book(s, svc)).body;
    const co = (await call('POST', `/v1/bookings/${k2.id}/checkout`, s.customer)).body;
    expect((await call('POST', `/v1/bookings/${k2.id}/cancel`, s.staff)).body.error.code).toBe('booking_unpaid');
    expect((await call('POST', `/v1/bookings/${k2.id}/cancel`, s.customer)).body).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
    expect(stripe.sessions.get(sessionOf(co.url))!.status).toBe('expired');
    expect((await bookingPayment(k2.id)).status).toBe('cancelled');
  });

  it('refunds the deposit when the customer cancels in time, and keeps it when they cancel late', async () => {
    const s = await ready();
    const lenient = await service(s, 1000, 1);
    const strict = await service(s, 1500, 168);
    const early = await paidBooking(s, lenient, day(3));
    expect(early.deposit).toMatchObject({ status: 'paid', freeCancelUntil: new Date(new Date(early.startsAt).getTime() - 3600_000).toISOString() });
    const cancelled = (await call('POST', `/v1/bookings/${early.id}/cancel`, s.customer)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', deposit: { status: 'refunded', refundedMinor: 1000, refundDue: true } });
    const refund = (await call('GET', `/v1/bookings/${early.id}/payment`, s.customer)).body.payment.refunds;
    expect(refund).toEqual([expect.objectContaining({ amountMinor: 1000, origin: 'auto', status: 'succeeded', reason: 'The booking was cancelled in time' })]);

    const late = await paidBooking(s, strict, day(3));
    const kept = (await call('POST', `/v1/bookings/${late.id}/cancel`, s.customer)).body;
    expect(kept).toMatchObject({ status: 'cancelled', deposit: { status: 'paid', refundedMinor: 0, refundDue: false } });
    await payments.sweep();
    expect((await bookingPayment(late.id)).refunded_minor).toBe('0');
    expect(await ledgerFor((await bookingPayment(early.id)).id)).toEqual(
      expect.arrayContaining([
        { kind: 'refund', account: 'external:customers', amount: 1000 },
        { kind: 'refund', account: `business:${s.b.id}:sales`, amount: -900 },
        { kind: 'refund', account: 'platform:fees', amount: -100 },
      ]),
    );
  });

  it('refunds in full when the business cancels, keeps the deposit for a no-show, and lets managers refund', async () => {
    const s = await ready();
    const svc = await service(s, 2000, 168);
    const a = await paidBooking(s, svc, day(2));
    expect((await call('POST', `/v1/bookings/${a.id}/cancel`, s.staff)).body).toMatchObject({ status: 'cancelled', cancelledBy: 'business', deposit: { status: 'refunded' } });
    expect((await call('GET', `/v1/bookings/${a.id}/payment`, s.manager)).body.payment.refunds[0]).toMatchObject({ reason: 'The business cancelled the booking', amountMinor: 2000 });

    const b = await paidBooking(s, svc, day(3));
    await pool.query(`UPDATE bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
    expect((await call('POST', `/v1/bookings/${b.id}/outcome`, s.staff, { status: 'no_show' })).body).toMatchObject({ status: 'no_show', deposit: { status: 'paid' } });
    await payments.sweep();
    expect((await bookingPayment(b.id)).refunded_minor).toBe('0');
    // A goodwill refund of half, by a manager only.
    const refund = (amountMinor: number, u: TestUser) => call('POST', `/v1/bookings/${b.id}/refunds`, u, { amountMinor, reason: 'Goodwill', clientId: clientId() });
    expect((await refund(1000, s.staff)).status).toBe(403);
    expect((await refund(1000, s.customer)).status).toBe(403);
    expect((await refund(2001, s.manager)).body.error.code).toBe('refund_too_large');
    const r = (await refund(1000, s.manager)).body;
    expect(r.refund).toMatchObject({ amountMinor: 1000, origin: 'staff', status: 'succeeded' });
    expect(r.payment).toMatchObject({ status: 'partially_refunded', refundableMinor: 1000 });
  });

  it('refunds a deposit that arrives after the booking was cancelled', async () => {
    const s = await ready();
    const svc = await service(s, 1000, 168);
    const k = (await book(s, svc)).body;
    const { url } = (await call('POST', `/v1/bookings/${k.id}/checkout`, s.customer)).body;
    // The provider is down when the customer cancels, so the checkout stays open and they pay anyway.
    stripe.failNext(/\/expire$/, 503);
    expect((await call('POST', `/v1/bookings/${k.id}/cancel`, s.customer)).body.status).toBe('cancelled');
    await stripe.pay(sessionOf(url));
    const after = (await call('GET', `/v1/bookings/${k.id}`, s.customer)).body;
    expect(after).toMatchObject({ status: 'cancelled', deposit: { status: 'refunded', refundedMinor: 1000 } });
  });

  it('follows the cancellation rules when a customer deletes their account, and gives deposits back when a business closes', async () => {
    const s = await ready();
    const svc = await service(s, 1000, 1);
    const strict = await service(s, 1200, 168);
    const a = await paidBooking(s, svc, day(2));
    // Too late for this one's free cancellation.
    const c = await paidBooking(s, strict, day(3));
    expect((await call('DELETE', '/v1/me', s.customer, { password: s.customer.password })).status).toBe(204);
    // Leaving counts as cancelling: in time for one, too late for the other.
    expect((await bookingPayment(a.id)).refunded_minor).toBe('1000');
    expect((await bookingPayment(c.id)).refunded_minor).toBe('0');
    expect((await pool.query('SELECT status, cancelled_by, customer_id FROM bookings WHERE id = $1', [c.id])).rows[0]).toEqual({ status: 'cancelled', cancelled_by: 'customer', customer_id: null });

    const t = await ready();
    const svc2 = await service(t, 800, 168);
    const k = await paidBooking(t, svc2, day(2));
    expect((await call('DELETE', `/v1/businesses/${t.b.id}`, t.owner)).status).toBe(204);
    expect((await bookingPayment(k.id)).refunded_minor).toBe('800');
  });
});

describe('disputes', () => {
  it('takes the business’s share back while the bank decides, and refuses refunds meanwhile', async () => {
    const s = await ready();
    const managerSocket = await connect(s.manager);
    const { order, payment } = await paidOrder(s);
    const dp = await stripe.dispute(payment.provider_payment_id, { reason: 'product_not_received' });
    const pushed = (await managerSocket.next((f) => f.type === 'business.dispute.updated')).data;
    expect(pushed).toMatchObject({ orderId: order.id, amountMinor: 5000, status: 'needs_response', reason: 'product_not_received', open: true, canRespond: true });

    const list = (await call('GET', `/v1/businesses/${s.b.id}/disputes`, s.manager)).body.disputes;
    expect(list).toEqual([expect.objectContaining({ orderId: order.id, amountMinor: 5000, evidenceDueBy: expect.any(String) })]);
    expect((await call('GET', `/v1/businesses/${s.b.id}/disputes`, s.staff)).status).toBe(403);
    expect((await call('GET', `/v1/orders/${order.id}/payment`, s.manager)).body.payment).toMatchObject({ disputedMinor: 5000, refundableMinor: 0, disputes: [expect.objectContaining({ status: 'needs_response' })] });
    // Customer has the money back; the business gives back its share, the platform its fee.
    expect((await ledgerFor(payment.id)).filter((e) => e.kind === 'dispute')).toEqual([
      { kind: 'dispute', account: 'external:customers', amount: 5000 },
      { kind: 'dispute', account: `business:${s.b.id}:sales`, amount: -4500 },
      { kind: 'dispute', account: 'platform:fees', amount: -500 },
    ]);
    const reversal = stripe.requests.find((r) => r.path.endsWith('/reversals') && r.params.metadata?.dispute_id === list[0].id);
    expect(reversal).toMatchObject({ params: { amount: '4500' }, idempotencyKey: `dispute-recover:${list[0].id}` });
    expect((await call('POST', `/v1/orders/${order.id}/refunds`, s.manager, { reason: 'x', clientId: clientId() })).body.error.code).toBe('payment_disputed');
    expect(dp.status).toBe('needs_response');
  });

  it('sends the business’s response once, and gives the money back when the business wins', async () => {
    const s = await ready();
    const { order, payment } = await paidOrder(s);
    await stripe.dispute(payment.provider_payment_id);
    const [d] = (await call('GET', `/v1/businesses/${s.b.id}/disputes`, s.manager)).body.disputes;
    const respond = (u: TestUser, text: string) => call('POST', `/v1/disputes/${d.id}/response`, u, { text });
    const story = 'The customer collected the gift card in person on Monday and signed for it.';
    expect((await respond(s.staff, story)).status).toBe(403);
    expect((await respond(s.manager, 'too short')).status).toBe(400);
    const sent = (await respond(s.manager, story)).body;
    expect(sent).toMatchObject({ status: 'under_review', canRespond: false, evidenceSubmittedAt: expect.any(String) });
    expect(stripe.disputes.get([...stripe.disputes.keys()].pop()!)!.evidence).toEqual({ uncategorized_text: story });
    expect((await respond(s.manager, story)).body.error.code).toBe('dispute_closed');

    await stripe.closeDispute([...stripe.disputes.keys()].pop()!, 'won');
    const p = (await call('GET', `/v1/orders/${order.id}/payment`, s.manager)).body.payment;
    expect(p).toMatchObject({ disputedMinor: 0, refundableMinor: 5000, disputes: [expect.objectContaining({ status: 'won' })] });
    expect((await ledgerFor(payment.id)).filter((e) => e.kind === 'dispute_reinstated')).toEqual([
      { kind: 'dispute_reinstated', account: 'external:customers', amount: -5000 },
      { kind: 'dispute_reinstated', account: `business:${s.b.id}:sales`, amount: 4500 },
      { kind: 'dispute_reinstated', account: 'platform:fees', amount: 500 },
    ]);
    expect(stripe.requests.find((r) => r.path === '/v1/transfers' && r.params.metadata?.dispute_id === d.id)).toMatchObject({
      params: { amount: '4500', destination: s.acct, currency: 'gbp' },
      idempotencyKey: `dispute-return:${d.id}`,
    });
    // Refunds work again once the bank has decided.
    expect((await call('POST', `/v1/orders/${order.id}/refunds`, s.manager, { amountMinor: 100, reason: 'Sorry', clientId: clientId() })).body.refund.status).toBe('succeeded');
  });

  it('keeps the money with the customer when the business loses, and ignores events that arrive late or twice', async () => {
    const s = await ready();
    const { payment } = await paidOrder(s);
    stripe.autoDeliver = false;
    const dp = await stripe.dispute(payment.provider_payment_id, { amount: 2000 });
    const [created, withdrawn] = stripe.events.slice(-2);
    // Delivered out of order and twice.
    expect(await stripe.deliver(withdrawn!)).toBe(200);
    expect(await stripe.deliver(created!)).toBe(200);
    expect(await stripe.deliver(withdrawn!)).toBe(200);
    await stripe.closeDispute(dp.id, 'lost');
    const closed = stripe.last('charge.dispute.closed')!;
    await stripe.deliver(closed);
    // An older update after the decision changes nothing.
    await stripe.deliver({ ...created!, id: 'evt_old_update', type: 'charge.dispute.updated', created: created!.created - 10, data: { object: { ...created!.data.object, status: 'under_review' } } });
    const { rows } = await pool.query('SELECT status, amount_minor FROM disputes WHERE provider_dispute_id = $1', [dp.id]);
    expect(rows).toEqual([{ status: 'lost', amount_minor: '2000' }]);
    expect((await pool.query('SELECT disputed_minor, refunded_minor FROM payments WHERE id = $1', [payment.id])).rows[0]).toEqual({ disputed_minor: '2000', refunded_minor: '0' });
    expect((await ledgerFor(payment.id)).filter((e) => e.kind === 'dispute' && e.account === 'external:customers')).toEqual([{ kind: 'dispute', account: 'external:customers', amount: 2000 }]);
    // What's left can still be refunded.
    expect((await call('GET', `/v1/orders/${(await pool.query('SELECT order_id FROM payments WHERE id = $1', [payment.id])).rows[0].order_id}/payment`, s.manager)).body.payment.refundableMinor).toBe(3000);
  });

  it('records an inquiry without moving money, and retries taking the share back when the provider was down', async () => {
    const s = await ready();
    const one = await paidOrder(s);
    await stripe.dispute(one.payment.provider_payment_id, { withdraw: false });
    expect((await pool.query('SELECT status, funds_withdrawn_at FROM disputes WHERE payment_id = $1', [one.payment.id])).rows[0]).toEqual({ status: 'warning_needs_response', funds_withdrawn_at: null });
    expect((await ledgerFor(one.payment.id)).some((e) => e.kind === 'dispute')).toBe(false);

    const two = await paidOrder(s);
    stripe.failNext(/\/reversals$/, 503);
    await stripe.dispute(two.payment.provider_payment_id);
    const row = async () => (await pool.query('SELECT recovery_reversal_id FROM disputes WHERE payment_id = $1', [two.payment.id])).rows[0].recovery_reversal_id;
    expect(await row()).toBeNull();
    await payments.sweep();
    expect(await row()).toMatch(/^trr_/);
  });
});

describe('changing plan', () => {
  let admin: TestUser;
  const code = (name: string) => `${name}-${process.pid % 10000}`;
  beforeAll(async () => {
    admin = await staffMember('admin');
    for (const [name, price, interval, ents] of [
      ['basic', 1000, 'month', ['staff.extra']],
      ['pro', 3000, 'month', ['staff.extra', 'catalogue.extra']],
      ['pro-year', 30000, 'year', ['staff.extra', 'catalogue.extra']],
    ] as const) {
      const p = (await call('POST', '/v1/admin/plans', admin, { code: code(name), name, priceMinor: price, currency: 'GBP', interval, entitlements: ents })).body;
      await call('POST', `/v1/admin/plans/${p.id}/state`, admin, { state: 'active' });
    }
    const usd = (await call('POST', '/v1/admin/plans', admin, { code: code('usd'), name: 'USD', priceMinor: 900, currency: 'USD', interval: 'month', entitlements: ['staff.extra'] })).body;
    await call('POST', `/v1/admin/plans/${usd.id}/state`, admin, { state: 'active' });
  });

  async function subscribed(plan = 'basic') {
    const s = await business();
    const { url } = (await call('POST', `/v1/businesses/${s.b.id}/subscription`, s.owner, { planCode: code(plan), clientId: clientId() })).body;
    await stripe.pay(sessionOf(url));
    expect((await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.owner)).body.subscription.plan.code).toBe(code(plan));
    return s;
  }
  const subOf = async (s: Biz) => (await call('GET', `/v1/businesses/${s.b.id}/subscription`, s.owner)).body;

  it('previews and makes an upgrade, charging the difference now and unlocking the new limits', async () => {
    const s = await subscribed('basic');
    const preview = await call('POST', `/v1/businesses/${s.b.id}/subscription/preview`, s.owner, { planCode: code('pro') });
    expect(preview.body).toMatchObject({ plan: { code: code('pro') }, from: { code: code('basic') }, currency: 'GBP', intervalChanges: false });
    // About a whole month is left: close to the 20.00 difference.
    expect(preview.body.amountDueNowMinor).toBeGreaterThan(1990);
    expect(preview.body.amountDueNowMinor).toBeLessThanOrEqual(2000);
    expect((await call('POST', `/v1/businesses/${s.b.id}/subscription/preview`, s.manager, { planCode: code('pro') })).status).toBe(403);
    expect((await subOf(s)).limits).toEqual({ staff: 100, catalogue: 500 });

    const before = (await pool.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'subscription_invoice'`)).rows[0].n;
    const changed = (await call('POST', `/v1/businesses/${s.b.id}/subscription/change`, s.owner, { planCode: code('pro'), clientId: clientId() })).body;
    expect(changed).toMatchObject({ subscription: { plan: { code: code('pro') }, status: 'active' }, limits: { staff: 100, catalogue: 5000 } });
    const req = stripe.requests.filter((r) => r.method === 'POST' && /^\/v1\/subscriptions\/sub_/.test(r.path)).pop()!;
    expect(req.params).toMatchObject({ proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete', items: [{ price: expect.stringMatching(/^price_/) }] });
    // The prorated invoice is income in the ledger.
    expect((await pool.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'subscription_invoice'`)).rows[0].n).toBe(before + 1);
  });

  it('downgrades with a credit, and switches to a yearly plan', async () => {
    const s = await subscribed('pro');
    const preview = (await call('POST', `/v1/businesses/${s.b.id}/subscription/preview`, s.owner, { planCode: code('basic') })).body;
    expect(preview.amountDueNowMinor).toBeLessThan(0);
    const down = (await call('POST', `/v1/businesses/${s.b.id}/subscription/change`, s.owner, { planCode: code('basic'), clientId: clientId() })).body;
    expect(down).toMatchObject({ subscription: { plan: { code: code('basic') } }, limits: { staff: 100, catalogue: 500 } });
    const yearly = (await call('POST', `/v1/businesses/${s.b.id}/subscription/preview`, s.owner, { planCode: code('pro-year') })).body;
    expect(yearly).toMatchObject({ intervalChanges: true });
    // A new year starts now, less the unused month of the plan it replaces.
    expect(yearly.amountDueNowMinor).toBeGreaterThan(28_900);
    expect(yearly.amountDueNowMinor).toBeLessThanOrEqual(29_000);
    const up = (await call('POST', `/v1/businesses/${s.b.id}/subscription/change`, s.owner, { planCode: code('pro-year'), clientId: clientId() })).body;
    expect(up.subscription.plan).toMatchObject({ code: code('pro-year'), interval: 'year' });
    expect(new Date(up.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 300 * 86400_000);
  });

  it('refuses changes that can’t be made in place, and keeps the plan when the card is declined', async () => {
    const s = await subscribed('basic');
    const change = (planCode: string) => call('POST', `/v1/businesses/${s.b.id}/subscription/change`, s.owner, { planCode, clientId: clientId() });
    expect((await change(code('basic'))).body.error.code).toBe('same_plan');
    expect((await change(code('usd'))).body.error.code).toBe('currency_mismatch');
    expect((await change('no-such-plan')).status).toBe(404);
    stripe.failNext(/^POST \/v1\/subscriptions\/sub_/, 402);
    expect((await change(code('pro'))).body.error.code).toBe('payment_provider_refused');
    expect((await subOf(s)).subscription.plan.code).toBe(code('basic'));
    await call('DELETE', `/v1/businesses/${s.b.id}/subscription`, s.owner);
    expect((await change(code('pro'))).body.error.code).toBe('subscription_ending');
    const none = await business();
    expect((await call('POST', `/v1/businesses/${none.b.id}/subscription/change`, none.owner, { planCode: code('pro'), clientId: clientId() })).status).toBe(404);
  });

  it('isn’t undone by an older event that arrives after the change', async () => {
    const s = await subscribed('basic');
    stripe.autoDeliver = false;
    const sub = [...stripe.subscriptions.values()].find((x) => x.metadata.business_id === s.b.id)!;
    const stale = { id: 'evt_stale_basic', object: 'event', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: structuredClone(sub) } };
    await call('POST', `/v1/businesses/${s.b.id}/subscription/change`, s.owner, { planCode: code('pro'), clientId: clientId() });
    // Same second as the change, with the old price: applied, then corrected from the provider.
    expect(await stripe.deliver(stale)).toBe(200);
    expect((await subOf(s)).subscription.plan.code).toBe(code('pro'));
    expect(await stripe.deliver({ ...stale, id: 'evt_stale_older', created: stale.created - 60 })).toBe(200);
    expect((await subOf(s)).subscription.plan.code).toBe(code('pro'));
    // The upgrade's invoice, held back above, still has to reach the ledger.
    expect(await stripe.deliver(stripe.last('invoice.paid')!)).toBe(200);
  });
});

describe('payouts and reconciliation', () => {
  it('shows a business its payouts from the provider, to managers only', async () => {
    const s = await ready();
    stripe.payout(s.acct, 4500, 'gbp', 'paid');
    stripe.payout(s.acct, 1200, 'gbp', 'in_transit');
    const r = (await call('GET', `/v1/businesses/${s.b.id}/payouts`, s.manager)).body;
    expect(r).toMatchObject({ connected: true, payouts: [expect.objectContaining({ amountMinor: 1200, status: 'in_transit', currency: 'GBP' }), expect.objectContaining({ amountMinor: 4500, status: 'paid' })] });
    expect((await call('GET', `/v1/businesses/${s.b.id}/payouts`, s.staff)).status).toBe(403);
    const fresh = await business();
    expect((await call('GET', `/v1/businesses/${fresh.b.id}/payouts`, fresh.owner)).body).toEqual({ connected: false, payouts: [] });
  });

  it('agrees with the provider’s balance records, and points out what a lost webhook missed', async () => {
    const admin = await staffMember('admin');
    const period = () => `from=${started.toISOString()}&to=${new Date(Date.now() + 1000).toISOString()}`;
    const ok = (await call('GET', `/v1/admin/reconciliation?${period()}`, admin)).body;
    expect(ok).toMatchObject({ ok: true, problems: [] });
    expect(ok.matched).toBeGreaterThan(10);
    expect(ok.subscriptions).toEqual([expect.objectContaining({ currency: 'GBP', differenceMinor: 0 })]);
    expect((await call('GET', `/v1/admin/reconciliation?${period()}`, await staffMember('moderator'))).body.error.code).toBe('admin_only');
    expect((await call('GET', `/v1/admin/reconciliation?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`, admin)).status).toBe(400);

    // A refund made in the provider's dashboard whose webhook never arrives.
    const s = await ready();
    const { payment } = await paidOrder(s);
    stripe.autoDeliver = false;
    const lost = await stripe.dashboardRefund(payment.provider_payment_id, 700);
    const after = (await call('GET', `/v1/admin/reconciliation?${period()}`, admin)).body;
    expect(after.ok).toBe(false);
    expect(after.problems).toEqual([{ problem: 'unknown_at_provider', kind: 'refund', ref: lost.id, currency: 'GBP', ourAmountMinor: null, providerAmountMinor: -700 }]);
    // The ledger's own check still agrees with our records, disputes included.
    expect((await call('GET', '/v1/admin/ledger', admin)).body.check).toMatchObject({ ok: true, problems: [] });
  });
});

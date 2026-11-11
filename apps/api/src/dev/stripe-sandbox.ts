import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { signStripePayload } from '../payments/stripe';

/**
 * A local stand-in for the parts of Stripe that SuperApp uses: Connect accounts, hosted
 * Checkout (payments and subscriptions), refunds, products and prices, subscriptions and
 * plan changes with proration, disputes, transfers and their reversals, connected-account
 * payouts, the platform's balance transactions, the billing portal, and signed webhooks.
 * It checks what Stripe checks (the secret key, idempotency keys reused with different
 * parameters, refunds larger than what is left or on a disputed charge, reversals larger
 * than the transfer) and serves simple hosted pages, so payments can be clicked through in
 * local development and the browser tests without a Stripe account. Not for production:
 * it holds no money. Card fees, tax, 3-D Secure and payout timing aren't imitated.
 */

type Obj = Record<string, any>;

export interface SandboxOptions {
  secretKey: string;
  webhookSecret: string;
  /** Where events are POSTed. Without it they are only recorded. */
  webhookUrl?: string;
  port?: number;
  /** Deliver each event as it happens (default). Tests can turn this off and deliver by hand. */
  autoDeliver?: boolean;
  /** Status that new refunds start in. Real card refunds are usually 'succeeded' at once. */
  refundStatus?: 'succeeded' | 'pending';
}

export interface Delivery {
  event: Obj;
  status: number;
}

export class StripeSandbox {
  url = '';
  readonly events: Obj[] = [];
  readonly deliveries: Delivery[] = [];
  /** Every API request, for assertions: method, path, parsed params and idempotency key. */
  readonly requests: { method: string; path: string; params: Obj; idempotencyKey?: string }[] = [];
  readonly accounts = new Map<string, Obj>();
  readonly sessions = new Map<string, Obj>();
  readonly intents = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  readonly customers = new Map<string, Obj>();
  readonly products = new Map<string, Obj>();
  readonly prices = new Map<string, Obj>();
  readonly subscriptions = new Map<string, Obj>();
  readonly invoices = new Map<string, Obj>();
  readonly charges = new Map<string, Obj>();
  readonly transfers = new Map<string, Obj>();
  readonly disputes = new Map<string, Obj>();
  /** Payouts per connected account, newest first. */
  readonly payouts = new Map<string, Obj[]>();
  /** The platform's balance transactions, oldest first. */
  readonly balance: Obj[] = [];
  autoDeliver: boolean;
  refundStatus: 'succeeded' | 'pending';
  /** Where events are POSTed; can be set once the receiving server has a port. */
  webhookUrl?: string;
  private server?: http.Server;
  private readonly idempotency = new Map<string, { fingerprint: string; status: number; body: Obj }>();
  private readonly faults: { match: RegExp; status: number; times: number }[] = [];

  constructor(private readonly opts: SandboxOptions) {
    this.autoDeliver = opts.autoDeliver ?? true;
    this.refundStatus = opts.refundStatus ?? 'succeeded';
    this.webhookUrl = opts.webhookUrl;
  }

  async start(): Promise<string> {
    this.server = http.createServer((rq, rs) => {
      const chunks: Buffer[] = [];
      rq.on('data', (c) => chunks.push(c));
      rq.on('end', () => {
        this.handle(rq, Buffer.concat(chunks).toString('utf8'))
          .then(({ status, body, html, location }) => {
            if (location) {
              rs.writeHead(303, { location });
              rs.end();
            } else if (html !== undefined) {
              rs.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
              rs.end(html);
            } else {
              rs.writeHead(status, { 'content-type': 'application/json' });
              rs.end(JSON.stringify(body));
            }
          })
          .catch((err) => {
            rs.writeHead(500, { 'content-type': 'application/json' });
            rs.end(JSON.stringify({ error: { type: 'api_error', message: String(err?.message ?? err) } }));
          });
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** The next `times` API calls whose "METHOD /path" matches answer with `status`. */
  failNext(match: RegExp, status: number, times = 1) {
    this.faults.push({ match, status, times });
  }

  // ---------------------------------------------------------------- webhooks

  private emit(type: string, object: Obj): Obj {
    const event = {
      id: id('evt'),
      object: 'event',
      api_version: '2025-03-31.basil',
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: structuredClone(object) },
    };
    this.events.push(event);
    return event;
  }

  /** POSTs an event as Stripe would. Options let tests send it unsigned, badly signed or stale. */
  async deliver(event: Obj, opts: { secret?: string; signature?: string | null; now?: number; body?: string } = {}): Promise<number> {
    if (!this.webhookUrl) return 0;
    const payload = opts.body ?? JSON.stringify(event);
    const signature = opts.signature === undefined ? signStripePayload(payload, opts.secret ?? this.opts.webhookSecret, opts.now) : opts.signature;
    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
      body: payload,
    });
    this.deliveries.push({ event, status: res.status });
    return res.status;
  }

  private async send(events: Obj[]) {
    if (!this.autoDeliver) return;
    for (const e of events) await this.deliver(e);
  }

  /** The newest recorded event of a type. */
  last(type: string): Obj | undefined {
    return [...this.events].reverse().find((e) => e.type === type);
  }

  // ---------------------------------------------------------------- what people do on hosted pages

  /** The customer pays on the hosted Checkout page. */
  async pay(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    if (s.status !== 'open') throw new Error(`session ${sessionId} is ${s.status}`);
    const out: Obj[] = [];
    if (s.mode === 'payment') {
      const fee = s.payment_intent_data?.application_fee_amount ? Number(s.payment_intent_data.application_fee_amount) : 0;
      const pi = {
        id: id('pi'),
        object: 'payment_intent',
        amount: s.amount_total,
        amount_received: s.amount_total,
        currency: s.currency,
        status: 'succeeded',
        application_fee_amount: s.payment_intent_data?.application_fee_amount ? Number(s.payment_intent_data.application_fee_amount) : null,
        transfer_data: s.payment_intent_data?.transfer_data ?? null,
        metadata: s.payment_intent_data?.metadata ?? {},
        amount_refunded: 0,
        fee_refunded: 0,
        latest_charge: id('ch'),
      };
      this.intents.set(pi.id, pi);
      const dest = s.payment_intent_data?.transfer_data?.destination;
      const transfer = dest ? this.newTransfer(s.amount_total - fee, s.currency, dest, pi.latest_charge) : null;
      this.charges.set(pi.latest_charge, { id: pi.latest_charge, object: 'charge', amount: s.amount_total, currency: s.currency, payment_intent: pi.id, transfer: transfer?.id ?? null, disputed: false });
      this.book('charge', s.amount_total, s.currency, pi.latest_charge, 'charge');
      Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
      out.push(this.emit('payment_intent.succeeded', pi), this.emit('checkout.session.completed', s));
    } else {
      const customer = s.customer ?? this.newCustomer({ email: s.customer_email }).id;
      const price = this.prices.get(s.line_items[0].price);
      const sub = this.newSubscription(customer, price!, s.subscription_data?.metadata ?? {});
      const inv = this.newInvoice(sub, price!.unit_amount, price!.currency);
      Object.assign(s, { status: 'complete', payment_status: 'paid', subscription: sub.id, customer });
      out.push(this.emit('customer.subscription.created', sub), this.emit('checkout.session.completed', s), this.emit('invoice.paid', inv));
    }
    await this.send(out);
    return s;
  }

  /** The business finishes the provider's onboarding (identity, bank account). */
  async completeOnboarding(accountId: string, opts: { charges?: boolean; payouts?: boolean } = {}) {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error(`no account ${accountId}`);
    Object.assign(a, { details_submitted: true, charges_enabled: opts.charges ?? true, payouts_enabled: opts.payouts ?? true });
    await this.send([this.emit('account.updated', a)]);
    return a;
  }

  /** A pending refund settles at the bank. */
  async settleRefund(refundId: string, status: 'succeeded' | 'failed') {
    const r = this.refunds.get(refundId)!;
    r.status = status;
    if (status === 'failed') {
      const pi = this.intents.get(r.payment_intent)!;
      pi.amount_refunded -= r.amount;
      r.failure_reason = 'expired_or_canceled_card';
      this.book('refund_failure', r.amount, r.currency, r.id, 'refund_failure');
    }
    await this.send(status === 'failed' ? [this.emit('refund.failed', r), this.emit('refund.updated', r)] : [this.emit('refund.updated', r)]);
    return r;
  }

  /** Someone refunds from the Stripe dashboard, outside the app. */
  async dashboardRefund(paymentIntentId: string, amount?: number) {
    const r = this.createRefund({ payment_intent: paymentIntentId, amount, refund_application_fee: true, reverse_transfer: true });
    if ('error' in r) throw new Error(r.error.message);
    await this.send([this.emit('refund.created', r)]);
    return r;
  }

  /** The subscription renews and the invoice is paid, less any credit from a downgrade. */
  async renew(subscriptionId: string) {
    const sub = this.subscriptions.get(subscriptionId)!;
    const price = this.prices.get(sub.items.data[0].price.id)!;
    const end = sub.current_period_end + periodSeconds(price.recurring.interval);
    Object.assign(sub, { status: 'active', current_period_end: end });
    sub.items.data[0].current_period_end = end;
    const customer = this.customers.get(sub.customer);
    const credit = Math.min(price.unit_amount, -(customer?.balance ?? 0));
    if (customer && credit > 0) customer.balance += credit;
    const inv = this.newInvoice(sub, price.unit_amount - Math.max(0, credit), price.currency);
    await this.send([this.emit('invoice.paid', inv), this.emit('customer.subscription.updated', sub)]);
    return inv;
  }

  /** A renewal payment fails, so the subscription is past due. */
  async failRenewal(subscriptionId: string) {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.status = 'past_due';
    await this.send([this.emit('invoice.payment_failed', { id: id('in'), object: 'invoice', subscription: sub.id, status: 'open' }), this.emit('customer.subscription.updated', sub)]);
    return sub;
  }

  /** The subscription ends now (retries ran out, or it reached the end of a cancelled period). */
  async endSubscription(subscriptionId: string) {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.status = 'canceled';
    await this.send([this.emit('customer.subscription.deleted', sub)]);
    return sub;
  }

  /**
   * The customer's bank disputes a payment. Like Stripe, the money is taken from the
   * platform at once (funds_withdrawn) unless `withdraw` is false (an inquiry).
   */
  async dispute(paymentIntentId: string, opts: { amount?: number; reason?: string; withdraw?: boolean } = {}) {
    const pi = this.intents.get(paymentIntentId);
    if (!pi) throw new Error(`no payment intent ${paymentIntentId}`);
    const charge = this.charges.get(pi.latest_charge)!;
    const withdraw = opts.withdraw ?? true;
    const dp = {
      id: id('dp'),
      object: 'dispute',
      amount: opts.amount ?? pi.amount - pi.amount_refunded,
      currency: pi.currency,
      charge: charge.id,
      payment_intent: pi.id,
      reason: opts.reason ?? 'fraudulent',
      status: withdraw ? 'needs_response' : 'warning_needs_response',
      evidence: {} as Obj,
      evidence_details: { due_by: now() + 7 * 86400, submission_count: 0 },
      is_charge_refundable: false,
      livemode: false,
    };
    this.disputes.set(dp.id, dp);
    charge.disputed = true;
    const events = [this.emit('charge.dispute.created', dp)];
    if (withdraw) {
      this.book('adjustment', -dp.amount, dp.currency, dp.id, 'dispute');
      events.push(this.emit('charge.dispute.funds_withdrawn', dp));
    }
    await this.send(events);
    return dp;
  }

  /** The bank decides. A win gives the money back to the platform. */
  async closeDispute(disputeId: string, outcome: 'won' | 'lost') {
    const dp = this.disputes.get(disputeId)!;
    const inquiry = dp.status.startsWith('warning_');
    dp.status = inquiry ? 'warning_closed' : outcome;
    const events = [this.emit('charge.dispute.closed', dp)];
    if (outcome === 'won' && !inquiry) {
      this.book('adjustment', dp.amount, dp.currency, dp.id, 'dispute_reversal');
      events.push(this.emit('charge.dispute.funds_reinstated', dp));
    }
    this.charges.get(dp.charge)!.disputed = false;
    await this.send(events);
    return dp;
  }

  /** The provider pays a connected account's balance out to its bank. */
  payout(accountId: string, amount: number, currency: string, status: 'pending' | 'in_transit' | 'paid' | 'failed' = 'paid') {
    const p = { id: id('po'), object: 'payout', amount, currency, status, arrival_date: now() + 2 * 86400, created: now() };
    this.payouts.set(accountId, [p, ...(this.payouts.get(accountId) ?? [])]);
    return p;
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(rq: http.IncomingMessage, raw: string): Promise<{ status: number; body?: Obj; html?: string; location?: string }> {
    const url = new URL(rq.url ?? '/', this.url);
    const path = url.pathname;
    const method = rq.method ?? 'GET';
    // Hosted pages are what the customer's browser sees: no API key.
    if (!path.startsWith('/v1/')) return this.page(method, path, url, new URLSearchParams(raw));

    if (rq.headers.authorization !== `Bearer ${this.opts.secretKey}`) {
      return { status: 401, body: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } } };
    }
    const params = parseForm(raw);
    const key = rq.headers['idempotency-key'] as string | undefined;
    this.requests.push({ method, path, params, idempotencyKey: key });
    const fault = this.faults.find((f) => f.times > 0 && f.match.test(`${method} ${path}`));
    if (fault) {
      fault.times -= 1;
      return { status: fault.status, body: { error: { type: 'api_error', message: 'Injected failure' } } };
    }
    if (key) {
      const fingerprint = `${method} ${path} ${raw}`;
      const seen = this.idempotency.get(key);
      if (seen) {
        if (seen.fingerprint !== fingerprint) {
          return { status: 400, body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } } };
        }
        return { status: seen.status, body: seen.body };
      }
      const res = await this.api(method, path, params, url.searchParams, rq.headers['stripe-account'] as string | undefined);
      if (res.status < 500) this.idempotency.set(key, { fingerprint, status: res.status, body: res.body });
      return res;
    }
    return this.api(method, path, params, url.searchParams, rq.headers['stripe-account'] as string | undefined);
  }

  private async api(method: string, path: string, p: Obj, query: URLSearchParams, account?: string): Promise<{ status: number; body: Obj }> {
    const ok = (body: Obj) => ({ status: 200, body: structuredClone(body) });
    const missing = (what: string) => ({ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}` } } });
    const bad = (message: string, code?: string) => ({ status: 400, body: { error: { type: 'invalid_request_error', code, message } } });
    let m: RegExpExecArray | null;

    if (method === 'POST' && path === '/v1/accounts') {
      const a = { id: id('acct'), object: 'account', type: p.type ?? 'express', country: p.country, email: p.email ?? null, metadata: p.metadata ?? {}, charges_enabled: false, payouts_enabled: false, details_submitted: false };
      this.accounts.set(a.id, a);
      return ok(a);
    }
    if (method === 'GET' && (m = /^\/v1\/accounts\/([\w]+)$/.exec(path))) {
      const a = this.accounts.get(m[1]!);
      return a ? ok(a) : missing('account');
    }
    if (method === 'POST' && path === '/v1/account_links') {
      if (!this.accounts.has(p.account)) return missing('account');
      const q = new URLSearchParams({ return_url: p.return_url, refresh_url: p.refresh_url });
      return ok({ object: 'account_link', url: `${this.url}/connect/onboard/${p.account}?${q}`, expires_at: now() + 300 });
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const items: Obj[] = p.line_items ?? [];
      if (!items.length) return bad('line_items is required');
      if (p.mode === 'payment') {
        const currency = items[0]!.price_data?.currency;
        if (items.some((i) => i.price_data?.currency !== currency)) return bad('All line items must have the same currency');
        const dest = p.payment_intent_data?.transfer_data?.destination;
        if (dest) {
          const acct = this.accounts.get(dest);
          if (!acct) return missing('account');
          if (!acct.charges_enabled) return bad('The destination account cannot accept charges yet', 'account_invalid');
        }
        const total = items.reduce((sum, i) => sum + Number(i.price_data.unit_amount) * Number(i.quantity), 0);
        const fee = Number(p.payment_intent_data?.application_fee_amount ?? 0);
        if (fee > total) return bad('application_fee_amount cannot be more than the amount');
        const s = this.newSession(p, { amount_total: total, currency });
        return ok(s);
      }
      if (p.mode === 'subscription') {
        const price = this.prices.get(items[0]!.price);
        if (!price) return missing('price');
        if (p.customer && !this.customers.has(p.customer)) return missing('customer');
        return ok(this.newSession(p, { amount_total: price.unit_amount, currency: price.currency }));
      }
      return bad('mode must be payment or subscription');
    }
    if ((m = /^\/v1\/checkout\/sessions\/(cs_\w+)(\/expire)?$/.exec(path))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return missing('checkout.session');
      if (method === 'GET') return ok(s);
      if (method === 'POST' && m[2]) {
        if (s.status !== 'open') return bad('Only Checkout Sessions with a status in [open] can be expired.', 'checkout_session_not_open');
        s.status = 'expired';
        await this.send([this.emit('checkout.session.expired', s)]);
        return ok(s);
      }
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const r = this.createRefund(p);
      if ('error' in r) return { status: 400, body: r };
      await this.send([this.emit('refund.created', r)]);
      return ok(r);
    }
    if (method === 'POST' && path === '/v1/customers') return ok(this.newCustomer(p));
    if (method === 'POST' && path === '/v1/products') {
      const prod = { id: id('prod'), object: 'product', name: p.name, metadata: p.metadata ?? {} };
      this.products.set(prod.id, prod);
      return ok(prod);
    }
    if (method === 'POST' && path === '/v1/prices') {
      if (!this.products.has(p.product)) return missing('product');
      const price = { id: id('price'), object: 'price', product: p.product, unit_amount: Number(p.unit_amount), currency: p.currency, recurring: { interval: p.recurring?.interval }, active: true };
      this.prices.set(price.id, price);
      return ok(price);
    }
    if ((m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path))) {
      const sub = this.subscriptions.get(m[1]!);
      if (!sub) return missing('subscription');
      if (method === 'GET') return ok(sub);
      if (sub.status === 'canceled') return bad('This subscription has been canceled');
      if (method === 'POST') {
        if ('cancel_at_period_end' in p) sub.cancel_at_period_end = p.cancel_at_period_end === 'true';
        if (p.metadata) sub.metadata = { ...sub.metadata, ...p.metadata };
        const events: Obj[] = [];
        if (p.items?.[0]?.price) {
          const change = this.planChange(sub, p.items[0]);
          if ('error' in change) return { status: change.status, body: change };
          if (change.amount > 0 && p.proration_behavior === 'always_invoice') {
            const inv = this.newInvoice(sub, change.amount, change.price.currency);
            events.push(this.emit('invoice.paid', inv));
          } else if (change.amount < 0) {
            const c = this.customers.get(sub.customer);
            if (c) c.balance = (c.balance ?? 0) + change.amount;
          }
          sub.items.data[0].price = { id: change.price.id };
          sub.items.data[0].current_period_end = sub.current_period_end = change.periodEnd;
        }
        events.push(this.emit('customer.subscription.updated', sub));
        await this.send(events);
        return ok(sub);
      }
      if (method === 'DELETE') {
        sub.status = 'canceled';
        await this.send([this.emit('customer.subscription.deleted', sub)]);
        return ok(sub);
      }
    }
    if (method === 'POST' && path === '/v1/invoices/create_preview') {
      const sub = this.subscriptions.get(p.subscription);
      if (!sub) return missing('subscription');
      const item = p.subscription_details?.items?.[0];
      if (!item?.price) return bad('subscription_details[items] is required');
      const change = this.planChange(sub, item);
      if ('error' in change) return { status: change.status, body: change };
      return ok({ object: 'invoice', customer: sub.customer, subscription: sub.id, currency: change.price.currency, total: change.amount, amount_due: Math.max(0, change.amount) });
    }
    if (method === 'GET' && (m = /^\/v1\/charges\/(ch_\w+)$/.exec(path))) {
      const c = this.charges.get(m[1]!);
      return c ? ok(c) : missing('charge');
    }
    if (method === 'POST' && (m = /^\/v1\/transfers\/(tr_\w+)\/reversals$/.exec(path))) {
      const t = this.transfers.get(m[1]!);
      if (!t) return missing('transfer');
      const amount = p.amount === undefined ? t.amount - t.amount_reversed : Number(p.amount);
      if (amount <= 0 || amount > t.amount - t.amount_reversed) return bad(`Reversal amount (${amount}) is greater than what is left on the transfer (${t.amount - t.amount_reversed})`);
      t.amount_reversed += amount;
      const rev = { id: id('trr'), object: 'transfer_reversal', amount, currency: t.currency, transfer: t.id, metadata: p.metadata ?? {} };
      t.reversals.push(rev);
      this.book('transfer_reversal', amount, t.currency, rev.id, 'transfer_reversal');
      return ok(rev);
    }
    if (method === 'POST' && path === '/v1/transfers') {
      if (!this.accounts.has(p.destination)) return missing('account');
      const t = this.newTransfer(Number(p.amount), p.currency, p.destination, p.source_transaction ?? null);
      t.metadata = p.metadata ?? {};
      return ok(t);
    }
    if ((m = /^\/v1\/disputes\/(dp_\w+)$/.exec(path))) {
      const dp = this.disputes.get(m[1]!);
      if (!dp) return missing('dispute');
      if (method === 'GET') return ok(dp);
      if (method === 'POST') {
        if (!['needs_response', 'warning_needs_response'].includes(dp.status)) return bad('This dispute is no longer accepting evidence', 'dispute_already_closed');
        Object.assign(dp.evidence, p.evidence ?? {});
        if (p.submit === 'true') {
          dp.status = dp.status === 'warning_needs_response' ? 'warning_under_review' : 'under_review';
          dp.evidence_details.submission_count += 1;
        }
        await this.send([this.emit('charge.dispute.updated', dp)]);
        return ok(dp);
      }
    }
    if (method === 'GET' && path === '/v1/payouts') {
      if (!account || !this.accounts.has(account)) return bad('Send the Stripe-Account header for a connected account');
      return ok({ object: 'list', data: (this.payouts.get(account) ?? []).slice(0, Number(query.get('limit') ?? 10)), has_more: false });
    }
    if (method === 'GET' && path === '/v1/balance_transactions') {
      const gte = Number(query.get('created[gte]') ?? 0);
      const lt = Number(query.get('created[lt]') ?? Infinity);
      const limit = Math.min(100, Number(query.get('limit') ?? 10));
      const expand = query.getAll('expand[]').includes('data.source');
      // Newest first, like Stripe; starting_after continues after the given one.
      let list = [...this.balance].reverse().filter((b) => b.created >= gte && b.created < lt);
      const after = query.get('starting_after');
      if (after) list = list.slice(list.findIndex((b) => b.id === after) + 1);
      const page = list.slice(0, limit).map((b) => (expand ? { ...b, source: this.sourceOf(b.source) ?? b.source } : b));
      return ok({ object: 'list', data: page, has_more: list.length > limit });
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!this.customers.has(p.customer)) return missing('customer');
      return ok({ object: 'billing_portal.session', url: `${this.url}/portal/${p.customer}?${new URLSearchParams({ return_url: p.return_url })}` });
    }
    return { status: 404, body: { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${method}: ${path})` } } };
  }

  private newSession(p: Obj, extra: { amount_total: number; currency: string }) {
    const s = {
      id: id('cs_test'),
      object: 'checkout.session',
      mode: p.mode,
      status: 'open',
      payment_status: 'unpaid',
      url: '',
      success_url: p.success_url,
      cancel_url: p.cancel_url,
      client_reference_id: p.client_reference_id ?? null,
      customer: p.customer ?? null,
      customer_email: p.customer_email ?? null,
      metadata: p.metadata ?? {},
      line_items: p.line_items,
      payment_intent_data: p.payment_intent_data,
      subscription_data: p.subscription_data,
      expires_at: p.expires_at ? Number(p.expires_at) : now() + 86400,
      payment_intent: null,
      subscription: null,
      livemode: false,
      ...extra,
    };
    s.url = `${this.url}/checkout/${s.id}`;
    this.sessions.set(s.id, s);
    return s;
  }

  private createRefund(p: Obj): Obj {
    const pi = this.intents.get(p.payment_intent);
    if (!pi) return { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } };
    const charge = this.charges.get(pi.latest_charge);
    if (charge?.disputed) return { error: { type: 'invalid_request_error', code: 'charge_disputed', message: `Charge ${charge.id} has been charged back; cannot issue a refund.` } };
    const left = pi.amount - pi.amount_refunded;
    const amount = p.amount === undefined ? left : Number(p.amount);
    if (amount <= 0 || amount > left) {
      return { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})` } };
    }
    pi.amount_refunded += amount;
    const r = { id: id('re'), object: 'refund', amount, currency: pi.currency, payment_intent: pi.id, charge: pi.latest_charge, status: this.refundStatus, metadata: p.metadata ?? {}, reason: p.reason ?? null };
    this.refunds.set(r.id, r);
    this.book('refund', -amount, pi.currency, r.id, 'refund');
    // reverse_transfer takes the business's share back, in proportion, as Stripe does.
    const t = charge?.transfer ? this.transfers.get(charge.transfer) : null;
    if (p.reverse_transfer === 'true' && t) {
      const share = Math.min(t.amount - t.amount_reversed, Math.round((t.amount * amount) / pi.amount));
      if (share > 0) t.amount_reversed += share;
    }
    return r;
  }

  private newCustomer(p: Obj) {
    const c = { id: id('cus'), object: 'customer', email: p.email ?? null, metadata: p.metadata ?? {}, balance: 0 };
    this.customers.set(c.id, c);
    return c;
  }

  private newSubscription(customer: string, price: Obj, metadata: Obj) {
    const end = now() + periodSeconds(price.recurring.interval);
    const sub = {
      id: id('sub'),
      object: 'subscription',
      customer,
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: end,
      metadata,
      items: { object: 'list', data: [{ id: id('si'), price: { id: price.id }, current_period_end: end }] },
    };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  private newInvoice(sub: Obj, amount: number, currency: string) {
    const inv = {
      id: id('in'),
      object: 'invoice',
      status: 'paid',
      amount_paid: amount,
      currency,
      customer: sub.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
    };
    this.invoices.set(inv.id, inv);
    if (amount > 0) {
      // The invoice is paid by a charge of its own, not linked to any order.
      const ch = { id: id('ch'), object: 'charge', amount, currency, payment_intent: id('pi'), transfer: null, disputed: false };
      this.charges.set(ch.id, ch);
      this.book('charge', amount, currency, ch.id, 'charge');
    }
    return inv;
  }

  /**
   * What switching a subscription's price costs now. Same interval: the difference for the
   * time left. Another interval: a new period starts now, less credit for the unused time.
   */
  private planChange(sub: Obj, item: Obj): { amount: number; price: Obj; periodEnd: number } | { error: Obj; status: number } {
    const price = this.prices.get(item.price);
    if (!price) return { status: 404, error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price' } };
    if (item.id && item.id !== sub.items.data[0].id) return { status: 400, error: { type: 'invalid_request_error', message: 'No such subscription item' } };
    const old = this.prices.get(sub.items.data[0].price.id)!;
    if (old.currency !== price.currency) return { status: 400, error: { type: 'invalid_request_error', message: 'Currency must match the subscription' } };
    const period = periodSeconds(old.recurring.interval);
    const left = Math.max(0, Math.min(1, (sub.current_period_end - now()) / period));
    if (old.recurring.interval === price.recurring.interval) {
      return { amount: Math.round(price.unit_amount * left) - Math.round(old.unit_amount * left), price, periodEnd: sub.current_period_end };
    }
    return { amount: price.unit_amount - Math.round(old.unit_amount * left), price, periodEnd: now() + periodSeconds(price.recurring.interval) };
  }

  private newTransfer(amount: number, currency: string, destination: string, sourceTransaction: string | null) {
    const t: Obj = { id: id('tr'), object: 'transfer', amount, currency, destination, source_transaction: sourceTransaction, amount_reversed: 0, reversals: [], metadata: {} };
    this.transfers.set(t.id, t);
    this.book('transfer', -amount, currency, t.id, 'transfer');
    return t;
  }

  /** Records a movement of the platform's balance, as a balance transaction. */
  private book(type: string, amount: number, currency: string, source: string, category: string) {
    this.balance.push({ id: id('txn'), object: 'balance_transaction', type, amount, currency, source, reporting_category: category, created: now(), fee: 0, net: amount });
  }

  private sourceOf(sourceId: string): Obj | undefined {
    return this.charges.get(sourceId) ?? this.refunds.get(sourceId) ?? this.disputes.get(sourceId) ?? this.transfers.get(sourceId);
  }

  // ---------------------------------------------------------------- hosted pages

  private async page(method: string, path: string, url: URL, form: URLSearchParams): Promise<{ status: number; html?: string; location?: string }> {
    let m: RegExpExecArray | null;
    if ((m = /^\/checkout\/(cs_test_\w+)(\/pay)?$/.exec(path))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return { status: 404, html: shell('Not found', '<p>This checkout link is not valid.</p>') };
      if (method === 'POST' && m[2]) {
        if (s.status === 'open') await this.pay(s.id);
        return { status: 303, location: String(s.success_url).replace('{CHECKOUT_SESSION_ID}', s.id) };
      }
      if (s.status !== 'open') return { status: 410, html: shell('Checkout closed', `<p data-testid="checkout-closed">This checkout is ${esc(s.status)}.</p>`) };
      const lines = s.mode === 'payment'
        ? s.line_items.map((i: Obj) => `<li>${esc(i.quantity)} × ${esc(i.price_data.product_data.name)} — ${money(Number(i.price_data.unit_amount), s.currency)}</li>`).join('')
        : `<li>Subscription — ${money(s.amount_total, s.currency)}</li>`;
      return {
        status: 200,
        html: shell(
          'Sandbox checkout',
          `<p class="note">Test payment: no real card is charged.</p><ul>${lines}</ul>
           <p data-testid="checkout-total">Total: ${money(s.amount_total, s.currency)}</p>
           <form method="post" action="/checkout/${s.id}/pay"><button data-testid="checkout-pay" type="submit">Pay</button></form>
           <p><a data-testid="checkout-back" href="${esc(s.cancel_url)}">Back</a></p>`,
        ),
      };
    }
    if ((m = /^\/connect\/onboard\/(acct_\w+)(\/finish)?$/.exec(path))) {
      const a = this.accounts.get(m[1]!);
      if (!a) return { status: 404, html: shell('Not found', '<p>Unknown account.</p>') };
      if (method === 'POST' && m[2]) {
        await this.completeOnboarding(a.id);
        return { status: 303, location: form.get('return_url') ?? '/' };
      }
      return {
        status: 200,
        html: shell(
          'Sandbox payouts setup',
          `<p class="note">Test onboarding: no identity check or bank account is needed.</p>
           <form method="post" action="/connect/onboard/${a.id}/finish"><input type="hidden" name="return_url" value="${esc(url.searchParams.get('return_url') ?? '/')}">
           <button data-testid="onboarding-finish" type="submit">Finish setup</button></form>`,
        ),
      };
    }
    if ((m = /^\/portal\/(cus_\w+)(\/cancel\/(sub_\w+))?$/.exec(path))) {
      if (method === 'POST' && m[3]) {
        const sub = this.subscriptions.get(m[3]);
        if (sub && sub.status !== 'canceled') {
          sub.cancel_at_period_end = true;
          await this.send([this.emit('customer.subscription.updated', sub)]);
        }
        return { status: 303, location: form.get('return_url') ?? '/' };
      }
      const subs = [...this.subscriptions.values()].filter((s) => s.customer === m![1] && s.status !== 'canceled');
      const ret = esc(url.searchParams.get('return_url') ?? '/');
      return {
        status: 200,
        html: shell(
          'Sandbox billing',
          subs.map((s) => `<form method="post" action="/portal/${m![1]}/cancel/${s.id}"><input type="hidden" name="return_url" value="${ret}"><button data-testid="portal-cancel" type="submit">Cancel subscription</button></form>`).join('') +
            `<p><a data-testid="portal-back" href="${ret}">Back</a></p>`,
        ),
      };
    }
    return { status: 404, html: shell('Not found', '<p>Not found.</p>') };
  }
}

/** Parses Stripe-style bracket notation back into nested objects and arrays. */
export function parseForm(raw: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const parts = k.replace(/\]/g, '').split('[');
    let cur: any = out;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      if (last) cur[part] = v;
      else cur = cur[part] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

function id(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
function now() {
  return Math.floor(Date.now() / 1000);
}
function periodSeconds(interval: string) {
  return interval === 'year' ? 365 * 86400 : 30 * 86400;
}
function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function money(minor: number, currency: string) {
  return `${String(currency).toUpperCase()} ${(minor / 100).toFixed(2)}`;
}
function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}.note{background:#fff4d6;padding:.5rem .75rem;border-radius:6px}button{font:inherit;padding:.5rem 1rem}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

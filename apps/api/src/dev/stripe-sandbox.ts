import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { signStripePayload } from '../payments/stripe';

/**
 * A local stand-in for the parts of Stripe that Nexa uses: Connect accounts, hosted
 * Checkout (payments and subscriptions), refunds, products and prices, subscriptions,
 * the billing portal, and signed webhooks. It checks what Stripe checks (the secret key,
 * idempotency keys reused with different parameters, refunds larger than what is left)
 * and serves simple hosted pages, so payments can be clicked through in local development
 * and the browser tests without a Stripe account. Not for production: it holds no money.
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
      Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
      out.push(this.emit('payment_intent.succeeded', pi), this.emit('checkout.session.completed', s));
    } else {
      const customer = s.customer ?? this.newCustomer({ email: s.customer_email }).id;
      const price = this.prices.get(s.line_items[0].price);
      const sub = this.newSubscription(customer, price!, s.subscription_data?.metadata ?? {});
      const inv = this.newInvoice(sub, price!);
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

  /** The subscription renews and the invoice is paid. */
  async renew(subscriptionId: string) {
    const sub = this.subscriptions.get(subscriptionId)!;
    const price = this.prices.get(sub.items.data[0].price.id)!;
    const end = sub.current_period_end + periodSeconds(price.recurring.interval);
    Object.assign(sub, { status: 'active', current_period_end: end });
    sub.items.data[0].current_period_end = end;
    const inv = this.newInvoice(sub, price);
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
      const res = await this.api(method, path, params);
      if (res.status < 500) this.idempotency.set(key, { fingerprint, status: res.status, body: res.body });
      return res;
    }
    return this.api(method, path, params);
  }

  private async api(method: string, path: string, p: Obj): Promise<{ status: number; body: Obj }> {
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
        sub.cancel_at_period_end = p.cancel_at_period_end === 'true';
        await this.send([this.emit('customer.subscription.updated', sub)]);
        return ok(sub);
      }
      if (method === 'DELETE') {
        sub.status = 'canceled';
        await this.send([this.emit('customer.subscription.deleted', sub)]);
        return ok(sub);
      }
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
    const left = pi.amount - pi.amount_refunded;
    const amount = p.amount === undefined ? left : Number(p.amount);
    if (amount <= 0 || amount > left) {
      return { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})` } };
    }
    pi.amount_refunded += amount;
    const r = { id: id('re'), object: 'refund', amount, currency: pi.currency, payment_intent: pi.id, charge: pi.latest_charge, status: this.refundStatus, metadata: p.metadata ?? {}, reason: p.reason ?? null };
    this.refunds.set(r.id, r);
    return r;
  }

  private newCustomer(p: Obj) {
    const c = { id: id('cus'), object: 'customer', email: p.email ?? null, metadata: p.metadata ?? {} };
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

  private newInvoice(sub: Obj, price: Obj) {
    const inv = {
      id: id('in'),
      object: 'invoice',
      status: 'paid',
      amount_paid: price.unit_amount,
      currency: price.currency,
      customer: sub.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
    };
    this.invoices.set(inv.id, inv);
    return inv;
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

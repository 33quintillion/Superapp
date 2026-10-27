import { HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { BusinessesService } from '../business/businesses.service';
import { businessSales, LedgerService } from './ledger';
import { ProviderError, SignatureError, StripeClient, StripeEvent, verifyStripeSignature } from './stripe';

/** What the orders module does when a payment settles. Registered by OrdersService. */
export interface OrderHooks {
  /** pending_payment → placed. False when the order had already been closed. */
  paid(orderId: string, tx: Queryable): Promise<boolean>;
  /** pending_payment → cancelled, giving the stock back. False when it wasn't pending. */
  unpaid(orderId: string, reason: string, tx: Queryable): Promise<boolean>;
  /** Tells the customer and staff, after commit. `created` the first time staff see the order. */
  announce(orderId: string, created: boolean): Promise<void>;
}

/** Handles subscription events. Registered by SubscriptionsService. */
export interface BillingHooks {
  handles(type: string): boolean;
  apply(event: StripeEvent, tx: Queryable, after: After): Promise<void>;
}

/** Work to do once the transaction has committed (provider calls, live updates). */
export type After = (() => Promise<unknown>)[];

interface PaymentRow {
  id: string;
  order_id: string;
  business_id: string;
  payer_id: string | null;
  livemode: boolean;
  amount_minor: string;
  fee_minor: string;
  currency: string;
  destination_account: string;
  status: 'requires_payment' | 'succeeded' | 'cancelled';
  refunded_minor: string;
  checkout_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: Date | null;
  provider_payment_id: string | null;
  succeeded_at: Date | null;
  created_at: Date;
}

interface RefundRow {
  id: string;
  payment_id: string;
  amount_minor: string;
  fee_refund_minor: string;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  origin: 'staff' | 'auto' | 'provider';
  provider_refund_id: string | null;
  requested_by: string | null;
  client_id: string;
  created_at: Date;
}

interface AccountRow {
  business_id: string;
  livemode: boolean;
  account_id: string;
  country: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  updated_at: Date;
}

const unavailable = (message = 'The payment provider isn’t responding. Try again in a moment.') =>
  new AppError(HttpStatus.BAD_GATEWAY, 'payment_provider_unavailable', message);
const notEnabled = () => Errors.conflict('payments_not_enabled', 'Online payments aren’t set up on this server');

/** Stripe's session must last at least 30 minutes from when it is created. */
const MIN_SESSION_MS = 30 * 60_000;

/**
 * Online payments through a licensed provider (ADR 0005). The customer pays on the
 * provider's hosted checkout; the provider sends the money to the business's own
 * connected account, minus the platform fee. Nothing here holds funds.
 *
 * Safety rules:
 * - Every provider call carries an idempotency key derived from our own row ids, so a
 *   retry after a timeout can't charge or refund twice.
 * - Provider calls never happen inside a database transaction: the provider may call
 *   our webhook before it answers, and that must not wait on our locks.
 * - Webhooks are verified, checked for live/test mode, recorded by event id, and applied
 *   in the same transaction as that record, so a redelivery does nothing.
 * - A paid order that ends up cancelled is always refunded in full (sweep as backstop).
 */
@Injectable()
export class PaymentsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Payments');
  readonly stripe: StripeClient | null;
  private orders?: OrderHooks;
  private billing?: BillingHooks;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.stripe = config.PAYMENTS_PROVIDER === 'stripe' ? new StripeClient(config.STRIPE_SECRET_KEY!, config.STRIPE_API_BASE) : null;
  }

  useOrders(hooks: OrderHooks) {
    this.orders = hooks;
  }
  useBilling(hooks: BillingHooks) {
    this.billing = hooks;
  }

  get enabled() {
    return !!this.stripe;
  }

  /** The configured provider client, or a clear error when payments are off. */
  provider(): StripeClient {
    if (!this.stripe) throw notEnabled();
    return this.stripe;
  }

  onApplicationBootstrap() {
    const every = this.config.PAYMENTS_SWEEP_INTERVAL_SECONDS;
    if (!every || !this.stripe) return;
    this.timer = setInterval(() => this.sweep().catch((e) => this.logger.warn(`payments sweep failed: ${e.message}`)), every * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- payout accounts

  private accountView(a: AccountRow | null) {
    const usable = !!a && !!this.stripe && a.livemode === this.stripe.livemode && a.charges_enabled;
    return {
      provider: this.stripe ? 'stripe' : null,
      connected: !!a,
      country: a?.country ?? null,
      chargesEnabled: a?.charges_enabled ?? false,
      payoutsEnabled: a?.payouts_enabled ?? false,
      detailsSubmitted: a?.details_submitted ?? false,
      /** Customers can choose to pay online. */
      onlinePayments: usable,
      updatedAt: a?.updated_at ?? null,
    };
  }

  private loadAccount(businessId: string, q: Queryable = this.db.pool) {
    return this.db.one<AccountRow>('SELECT * FROM business_payment_accounts WHERE business_id = $1', [businessId], q);
  }

  /** Staff view of the payout account. Asks the provider for fresh status while setup is unfinished. */
  async account(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'payments.view');
    let a = await this.loadAccount(businessId);
    if (a && this.stripe && !a.charges_enabled) {
      try {
        a = await this.applyAccount(await this.stripe.get(`/v1/accounts/${encodeURIComponent(a.account_id)}`));
      } catch (err) {
        this.logger.warn(`account refresh failed: ${(err as Error).message}`);
      }
    }
    return { ...this.accountView(a), enabled: this.enabled };
  }

  /**
   * Starts (or continues) the provider's onboarding for the business's payout account and
   * returns the link to send the owner to. The provider does identity checks and holds the
   * bank details; we never see them.
   */
  async startOnboarding(userId: string, businessId: string, country: string) {
    await this.businesses.requireStaff(userId, businessId, 'payments.manage');
    const stripe = this.provider();
    await this.limits.consume({ name: 'payments:onboarding', limit: 20, windowSeconds: 3600 }, userId);
    const b = await this.businesses.get(userId, businessId);
    let a = await this.loadAccount(businessId);
    if (a && a.livemode !== stripe.livemode) throw Errors.conflict('account_mode_mismatch', 'This business’s payout account was made with test keys; ask support to reset it');
    if (!a) {
      const created = await stripe
        .post(
          '/v1/accounts',
          { type: 'express', country, business_profile: { name: b.name }, capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { business_id: businessId } },
          `account:${businessId}:${country}`,
        )
        .catch(rethrowProvider);
      await this.db.query(
        `INSERT INTO business_payment_accounts (business_id, provider, livemode, account_id, country, created_by) VALUES ($1, 'stripe', $2, $3, $4, $5)
           ON CONFLICT (business_id) DO NOTHING`,
        [businessId, stripe.livemode, created.id, country, userId],
      );
      a = (await this.loadAccount(businessId))!;
      await this.audit.record({ actorId: userId, action: 'payments.account.created', targetType: 'business', targetId: businessId, metadata: { country: a.country } });
    }
    const web = this.config.PUBLIC_WEB_URL;
    const back = `${web}/business/${encodeURIComponent(b.handle)}?tab=payments`;
    // Account links are single-use, so each request gets a fresh key.
    const link = await stripe
      .post('/v1/account_links', { account: a.account_id, type: 'account_onboarding', refresh_url: back, return_url: back }, `account-link:${businessId}:${Date.now()}`)
      .catch(rethrowProvider);
    return { url: link.url as string, account: this.accountView(a) };
  }

  private async applyAccount(acct: Record<string, any>, q: Queryable = this.db.pool) {
    return this.db.one<AccountRow>(
      `UPDATE business_payment_accounts SET charges_enabled = $2, payouts_enabled = $3, details_submitted = $4, updated_at = now()
        WHERE account_id = $1 RETURNING *`,
      [acct.id, !!acct.charges_enabled, !!acct.payouts_enabled, !!acct.details_submitted],
      q,
    );
  }

  /** Whether customers of this business can pay online right now. */
  async onlineAvailable(businessId: string, q: Queryable = this.db.pool) {
    return this.accountView(await this.loadAccount(businessId, q)).onlinePayments;
  }

  // ---------------------------------------------------------------- order payments

  /**
   * Called inside OrdersService.place's transaction for an online order: records what is
   * owed. The checkout itself is created afterwards, outside the transaction.
   */
  async prepareForOrder(tx: Queryable, o: { orderId: string; businessId: string; payerId: string; amountMinor: number; currency: string }) {
    const stripe = this.provider();
    const a = await this.loadAccount(o.businessId, tx);
    if (!this.accountView(a).onlinePayments) throw Errors.conflict('online_payments_unavailable', 'This business can’t take payment online yet; choose pay at pickup');
    if (o.amountMinor <= 0) throw Errors.conflict('nothing_to_pay', 'This order is free; choose pay at pickup');
    const fee = Math.floor((o.amountMinor * this.config.PAYMENTS_PLATFORM_FEE_BPS) / 10_000);
    await this.db.query(
      `INSERT INTO payments (order_id, business_id, payer_id, provider, livemode, amount_minor, fee_minor, currency, destination_account)
       VALUES ($1, $2, $3, 'stripe', $4, $5, $6, $7, $8)`,
      [o.orderId, o.businessId, o.payerId, stripe.livemode, o.amountMinor, fee, o.currency, a!.account_id],
      tx,
    );
  }

  private loadByOrder(orderId: string, q: Queryable = this.db.pool, lock = false) {
    return this.db.one<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [orderId], q);
  }

  /**
   * The hosted checkout link for the customer's unpaid order. Asking again returns the same
   * link; a retry after a timeout reuses the idempotency key, so only one session exists.
   */
  async checkout(customerId: string, orderId: string) {
    const stripe = this.provider();
    const o = await this.db.one<{ customer_id: string | null; status: string; handle: string }>(
      'SELECT o.customer_id, o.status, b.handle FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1',
      [orderId],
    );
    if (!o || o.customer_id !== customerId) throw Errors.notFound('Order');
    const p = await this.loadByOrder(orderId);
    if (!p) throw Errors.conflict('not_online', 'This order is paid at pickup');
    if (p.status === 'succeeded') throw Errors.conflict('already_paid', 'This order is already paid');
    if (p.status === 'cancelled' || o.status !== 'pending_payment') throw Errors.conflict('payment_closed', 'This order can no longer be paid; place it again');
    if (p.checkout_url && p.checkout_expires_at && p.checkout_expires_at.getTime() > Date.now() + 60_000) {
      return { url: p.checkout_url, expiresAt: p.checkout_expires_at };
    }
    if (p.checkout_id) throw Errors.conflict('payment_closed', 'The time to pay for this order has run out; place it again');
    await this.limits.consume({ name: 'payments:checkout', limit: 30, windowSeconds: 3600 }, customerId);

    // The expiry is part of the request, so it is saved first and reused by retries: same
    // parameters, same idempotency key. Only when too little time is left is a new one picked.
    let expires = p.checkout_expires_at;
    if (!expires || expires.getTime() < Date.now() + MIN_SESSION_MS + 30_000) {
      expires = new Date(Math.ceil((Date.now() + (this.config.PAYMENTS_CHECKOUT_MINUTES + 5) * 60_000) / 1000) * 1000);
      await this.db.query('UPDATE payments SET checkout_expires_at = $2, updated_at = now() WHERE id = $1 AND checkout_id IS NULL', [p.id, expires]);
    }
    const items = await this.db.query<{ name: string; unit_price_minor: string; quantity: number }>(
      'SELECT name, unit_price_minor, quantity FROM order_items WHERE order_id = $1 ORDER BY position',
      [orderId],
    );
    const web = this.config.PUBLIC_WEB_URL;
    const fee = Number(p.fee_minor);
    const session = await stripe
      .post(
        '/v1/checkout/sessions',
        {
          mode: 'payment',
          client_reference_id: p.id,
          line_items: items.rows.map((i) => ({
            quantity: i.quantity,
            price_data: { currency: p.currency.toLowerCase(), unit_amount: Number(i.unit_price_minor), product_data: { name: i.name } },
          })),
          payment_intent_data: {
            application_fee_amount: fee > 0 ? fee : undefined,
            transfer_data: { destination: p.destination_account },
            metadata: { payment_id: p.id, order_id: orderId },
          },
          metadata: { payment_id: p.id, order_id: orderId },
          success_url: `${web}/orders?paid=${orderId}`,
          cancel_url: `${web}/orders?order=${orderId}`,
          expires_at: Math.floor(expires.getTime() / 1000),
        },
        `checkout:${p.id}:${Math.floor(expires.getTime() / 1000)}`,
      )
      .catch(rethrowProvider);
    await this.db.query(
      `UPDATE payments SET checkout_id = $2, checkout_url = $3, updated_at = now() WHERE id = $1 AND (checkout_id IS NULL OR checkout_id = $2)`,
      [p.id, session.id, session.url],
    );
    return { url: session.url as string, expiresAt: expires };
  }

  /** Payment details for an order, for its customer or its business's staff. */
  async forOrder(userId: string, orderId: string) {
    const o = await this.db.one<{ customer_id: string | null; business_id: string }>('SELECT customer_id, business_id FROM orders WHERE id = $1', [orderId]);
    if (!o) throw Errors.notFound('Order');
    if (o.customer_id !== userId) await this.businesses.requireStaff(userId, o.business_id, 'orders.view').catch(() => Promise.reject(Errors.notFound('Order')));
    const p = await this.loadByOrder(orderId);
    if (!p) return { payment: null };
    const refunds = await this.db.query<RefundRow>('SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at', [p.id]);
    return { payment: { ...paymentView(p), refunds: refunds.rows.map(refundView) } };
  }

  /** Called after an order closes (cancelled, rejected, business closed): stop the checkout or give the money back. */
  async settleClosedOrder(orderId: string) {
    const p = await this.loadByOrder(orderId);
    if (!p || !this.stripe) return;
    if (p.status === 'requires_payment') await this.closeCheckout(p);
    else if (p.status === 'succeeded' && Number(p.refunded_minor) < Number(p.amount_minor)) {
      await this.createRefund(orderId, { origin: 'auto', reason: 'The order was cancelled', clientId: `auto:${orderId}`, requestedBy: null });
    }
  }

  /** Expires the hosted checkout and cancels the payment. If the customer paid just now, the payment wins and is refunded. */
  private async closeCheckout(p: PaymentRow) {
    if (p.checkout_id) {
      try {
        await this.stripe!.post(`/v1/checkout/sessions/${encodeURIComponent(p.checkout_id)}/expire`, {}, `expire:${p.checkout_id}`);
      } catch (err) {
        if (err instanceof ProviderError && err.retryable) throw err;
        // Not open any more: find out how it ended and apply that.
        const s = await this.stripe!.get(`/v1/checkout/sessions/${encodeURIComponent(p.checkout_id)}`);
        if (s.status === 'complete' && s.payment_status === 'paid') return this.applyEvent(synthetic('checkout.session.completed', s));
      }
    }
    await this.applyEvent(synthetic('checkout.session.expired', { id: p.checkout_id, metadata: { payment_id: p.id }, mode: 'payment' }));
  }

  // ---------------------------------------------------------------- refunds

  /** Staff refund all or part of a paid order. Safe to retry with the same clientId. */
  async refund(userId: string, orderId: string, input: { amountMinor?: number; reason: string; clientId: string }) {
    const o = await this.db.one<{ business_id: string; customer_id: string | null }>('SELECT business_id, customer_id FROM orders WHERE id = $1', [orderId]);
    if (!o) throw Errors.notFound('Order');
    await this.businesses.requireStaff(userId, o.business_id, 'orders.refund').catch((e) => {
      throw o.customer_id === userId ? Errors.forbidden('Only the business can refund') : e;
    });
    this.provider();
    await this.limits.consume({ name: 'payments:refund', limit: 60, windowSeconds: 3600 }, userId);
    return this.createRefund(orderId, { amountMinor: input.amountMinor, reason: input.reason, origin: 'staff', clientId: `staff:${input.clientId}`, requestedBy: userId });
  }

  private async createRefund(orderId: string, r: { amountMinor?: number; reason: string; origin: 'staff' | 'auto'; clientId: string; requestedBy: string | null }) {
    const refund = await this.db.tx(async (tx) => {
      const p = await this.loadByOrder(orderId, tx, true);
      if (!p || p.status !== 'succeeded') throw Errors.conflict('not_paid', 'This order hasn’t been paid online');
      const existing = await this.db.one<RefundRow>('SELECT * FROM refunds WHERE payment_id = $1 AND client_id = $2', [p.id, r.clientId], tx);
      if (existing) return existing;
      const amount = Number(p.amount_minor);
      const already = Number(p.refunded_minor);
      const left = amount - already;
      const want = r.amountMinor ?? left;
      if (want <= 0 || want > left) {
        if (r.origin === 'auto' && left === 0) return null;
        throw Errors.conflict('refund_too_large', `At most ${left} can be refunded`, { refundableMinor: left });
      }
      // The fee comes back in proportion; the last refund takes whatever is left so the
      // shares add up exactly, as the provider does.
      const fee = Number(p.fee_minor);
      const feeBack =
        already + want === amount
          ? fee - Number((await this.db.one<{ s: string }>(`SELECT coalesce(sum(fee_refund_minor), 0) AS s FROM refunds WHERE payment_id = $1 AND status <> 'failed'`, [p.id], tx))!.s)
          : Math.floor((fee * want) / amount);
      const row = await this.db.one<RefundRow>(
        `INSERT INTO refunds (payment_id, amount_minor, fee_refund_minor, reason, origin, requested_by, client_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [p.id, want, feeBack, r.reason, r.origin, r.requestedBy, r.clientId],
        tx,
      );
      await this.db.query('UPDATE payments SET refunded_minor = refunded_minor + $2, updated_at = now() WHERE id = $1', [p.id, want], tx);
      await this.audit.record({ actorId: r.requestedBy, action: 'payments.refund.requested', targetType: 'order', targetId: orderId, metadata: { amountMinor: want, origin: r.origin } }, tx);
      return row!;
    });
    if (!refund) return null;
    await this.sendRefund(refund.id);
    return refundView((await this.db.one<RefundRow>('SELECT * FROM refunds WHERE id = $1', [refund.id]))!);
  }

  /** Asks the provider for a recorded refund. A failure that can be retried is left for the sweep. */
  private async sendRefund(refundId: string) {
    const r = await this.db.one<RefundRow & { provider_payment_id: string }>(
      'SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1',
      [refundId],
    );
    if (!r || r.provider_refund_id || r.status !== 'pending') return;
    let res: Record<string, any>;
    try {
      res = await this.stripe!.post(
        '/v1/refunds',
        {
          payment_intent: r.provider_payment_id,
          amount: Number(r.amount_minor),
          // Destination charges: take the money back from the business and return our fee share.
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: { refund_id: r.id, payment_id: r.payment_id },
        },
        `refund:${r.id}`,
      );
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) {
        this.logger.warn(`refund ${r.id} will be retried: ${err.message}`);
        return;
      }
      this.logger.error(`refund ${r.id} refused by the provider: ${(err as Error).message}`);
      await this.db.tx((tx) => this.setRefundStatus(r.id, 'failed', tx, []));
      return;
    }
    await this.db.tx(async (tx) => {
      await this.db.query('UPDATE refunds SET provider_refund_id = $2, updated_at = now() WHERE id = $1 AND provider_refund_id IS NULL', [r.id, res.id], tx);
      await this.applyRefundObject(res, tx, []);
    });
  }

  private async setRefundStatus(refundId: string, to: 'succeeded' | 'failed', tx: Queryable, after: After) {
    const r = await this.db.one<RefundRow & { business_id: string; order_id: string; currency: string }>(
      `SELECT r.*, p.business_id, p.order_id, p.currency FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 FOR UPDATE OF r`,
      [refundId],
      tx,
    );
    if (!r || r.status !== 'pending') return;
    await this.db.query('UPDATE refunds SET status = $2, updated_at = now() WHERE id = $1', [r.id, to], tx);
    if (to === 'failed') {
      await this.db.query('UPDATE payments SET refunded_minor = refunded_minor - $2, updated_at = now() WHERE id = $1', [r.payment_id, r.amount_minor], tx);
    } else {
      const amount = Number(r.amount_minor);
      const fee = Number(r.fee_refund_minor);
      await this.ledger.post(
        {
          kind: 'refund',
          providerRef: r.provider_refund_id ?? `refund:${r.id}`,
          currency: r.currency,
          paymentId: r.payment_id,
          refundId: r.id,
          entries: [
            ['external:customers', amount],
            [businessSales(r.business_id), -(amount - fee)],
            ['platform:fees', -fee],
          ],
        },
        tx,
      );
    }
    await this.audit.record({ actorId: null, action: `payments.refund.${to}`, targetType: 'order', targetId: r.order_id, metadata: { refundId: r.id } }, tx);
    after.push(() => this.orders?.announce(r.order_id, false) ?? Promise.resolve());
  }

  /** A refund object from the provider: ours (matched by id or metadata) or one made in its dashboard. */
  private async applyRefundObject(re: Record<string, any>, tx: Queryable, after: After) {
    let r = await this.db.one<RefundRow>(
      'SELECT * FROM refunds WHERE provider_refund_id = $1 OR (provider_refund_id IS NULL AND id::text = $2) FOR UPDATE',
      [re.id, re.metadata?.refund_id ?? ''],
      tx,
    );
    if (r && !r.provider_refund_id) await this.db.query('UPDATE refunds SET provider_refund_id = $2 WHERE id = $1', [r.id, re.id], tx);
    if (!r) r = await this.recordOutsideRefund(re, tx);
    if (!r) return;
    if (re.status === 'succeeded') await this.setRefundStatus(r.id, 'succeeded', tx, after);
    else if (re.status === 'failed' || re.status === 'canceled') await this.setRefundStatus(r.id, 'failed', tx, after);
  }

  /** Refunds made outside the app still have to show up on the order and in the ledger. */
  private async recordOutsideRefund(re: Record<string, any>, tx: Queryable) {
    const p = await this.db.one<PaymentRow>('SELECT * FROM payments WHERE provider_payment_id = $1 FOR UPDATE', [re.payment_intent], tx);
    if (!p) return null;
    const amount = Number(re.amount);
    const left = Number(p.amount_minor) - Number(p.refunded_minor);
    if (amount > left) {
      this.logger.error(`refund ${re.id} is larger than what is left on payment ${p.id}; needs a look`);
      return null;
    }
    const fee = Number(p.fee_minor);
    const feeBack =
      amount === left
        ? fee - Number((await this.db.one<{ s: string }>(`SELECT coalesce(sum(fee_refund_minor), 0) AS s FROM refunds WHERE payment_id = $1 AND status <> 'failed'`, [p.id], tx))!.s)
        : Math.floor((fee * amount) / Number(p.amount_minor));
    const row = await this.db.one<RefundRow>(
      `INSERT INTO refunds (payment_id, amount_minor, fee_refund_minor, reason, origin, provider_refund_id, client_id) VALUES ($1, $2, $3, 'Refunded at the payment provider', 'provider', $4, $5) RETURNING *`,
      [p.id, amount, feeBack, re.id, `provider:${re.id}`],
      tx,
    );
    await this.db.query('UPDATE payments SET refunded_minor = refunded_minor + $2, updated_at = now() WHERE id = $1', [p.id, amount], tx);
    return row;
  }

  // ---------------------------------------------------------------- webhooks

  /** Verifies and applies one provider event. Duplicates are acknowledged and ignored. */
  async webhook(raw: Buffer | undefined, signature: string | undefined) {
    const stripe = this.provider();
    let event: StripeEvent;
    try {
      event = verifyStripeSignature(raw ?? Buffer.alloc(0), signature, this.config.STRIPE_WEBHOOK_SECRET, this.config.STRIPE_WEBHOOK_TOLERANCE_SECONDS);
    } catch (err) {
      if (err instanceof SignatureError) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_signature', `Webhook signature rejected: ${err.message}`);
      throw err;
    }
    if (event.livemode !== stripe.livemode) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'livemode_mismatch', 'This endpoint takes events from the other Stripe mode');
    }
    const fresh = await this.applyEvent(event, true);
    return { received: true, duplicate: !fresh };
  }

  /** Applies an event (or a synthetic one built by the sweep) in one transaction. */
  private async applyEvent(event: StripeEvent, record = false): Promise<boolean> {
    const after: After = [];
    const applied = await this.db.tx(async (tx) => {
      if (record) {
        const ins = await this.db.one(
          `INSERT INTO payment_events (provider, event_id, type, livemode, object_id, created_at) VALUES ('stripe', $1, $2, $3, $4, to_timestamp($5))
             ON CONFLICT DO NOTHING RETURNING event_id`,
          [event.id, event.type, event.livemode, typeof event.data.object.id === 'string' ? event.data.object.id : null, event.created],
          tx,
        );
        if (!ins) return false;
      }
      await this.dispatch(event, tx, after);
      return true;
    });
    for (const f of after) await f().catch((e) => this.logger.warn(`after ${event.type}: ${(e as Error).message}`));
    return applied;
  }

  private async dispatch(event: StripeEvent, tx: Queryable, after: After) {
    const o = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (o.mode === 'payment' && o.payment_status === 'paid') await this.paymentSucceeded(o, tx, after);
        else if (o.mode === 'subscription') await this.billing?.apply(event, tx, after);
        return;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        if (o.mode === 'payment') await this.paymentClosed(o, tx, after);
        return;
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        await this.applyRefundObject(o, tx, after);
        return;
      case 'account.updated':
        await this.applyAccount(o, tx);
        return;
      default:
        if (this.billing?.handles(event.type)) await this.billing.apply(event, tx, after);
    }
  }

  private findPayment(session: Record<string, any>, tx: Queryable) {
    return this.db.one<PaymentRow>(
      'SELECT * FROM payments WHERE checkout_id = $1 OR id::text = $2 ORDER BY (checkout_id = $1) DESC LIMIT 1 FOR UPDATE',
      [session.id ?? '', session.metadata?.payment_id ?? ''],
      tx,
    );
  }

  private async paymentSucceeded(session: Record<string, any>, tx: Queryable, after: After) {
    const p = await this.findPayment(session, tx);
    if (!p) {
      this.logger.warn(`paid checkout ${session.id} matches no payment`);
      return;
    }
    if (p.status === 'succeeded') return;
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    await this.db.query(
      `UPDATE payments SET status = 'succeeded', provider_payment_id = $2, checkout_id = coalesce(checkout_id, $3), succeeded_at = now(), updated_at = now() WHERE id = $1`,
      [p.id, pi, session.id ?? null],
      tx,
    );
    const amount = Number(p.amount_minor);
    const fee = Number(p.fee_minor);
    await this.ledger.post(
      {
        kind: 'payment',
        providerRef: pi,
        currency: p.currency,
        paymentId: p.id,
        entries: [
          ['external:customers', -amount],
          [businessSales(p.business_id), amount - fee],
          ['platform:fees', fee],
        ],
      },
      tx,
    );
    const placed = (await this.orders?.paid(p.order_id, tx)) ?? false;
    await this.audit.record({ actorId: null, action: 'payments.payment.succeeded', targetType: 'order', targetId: p.order_id, metadata: { amountMinor: amount } }, tx);
    // Paid after the order had closed (it expired or was cancelled meanwhile): give it all back.
    if (!placed) after.push(() => this.settleClosedOrder(p.order_id));
    after.push(() => this.orders?.announce(p.order_id, placed) ?? Promise.resolve());
  }

  private async paymentClosed(session: Record<string, any>, tx: Queryable, after: After) {
    const p = await this.findPayment(session, tx);
    if (!p || p.status !== 'requires_payment') return;
    await this.db.query(`UPDATE payments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [p.id], tx);
    const changed = (await this.orders?.unpaid(p.order_id, 'Payment wasn’t completed in time', tx)) ?? false;
    if (changed) after.push(() => this.orders?.announce(p.order_id, false) ?? Promise.resolve());
  }

  // ---------------------------------------------------------------- sweep

  /**
   * Backstop for lost webhooks and failed calls: closes or completes checkouts whose time
   * is up (asking the provider how they ended), retries refunds that never reached the
   * provider, and refunds paid orders that were cancelled. Safe to run on every instance.
   */
  async sweep() {
    if (!this.stripe) return;
    const minutes = this.config.PAYMENTS_CHECKOUT_MINUTES;
    const stale = await this.db.query<PaymentRow>(
      `SELECT * FROM payments WHERE status = 'requires_payment'
          AND ((checkout_id IS NULL AND created_at < now() - make_interval(mins => $1 + 10)) OR checkout_expires_at < now() - interval '2 minutes')
        ORDER BY created_at LIMIT 100`,
      [minutes],
    );
    for (const p of stale.rows) await this.closeCheckout(p).catch((e) => this.logger.warn(`closing checkout for ${p.id}: ${e.message}`));
    await this.settleClosedOrders();
    const unsent = await this.db.query<{ id: string }>(
      `SELECT id FROM refunds WHERE status = 'pending' AND provider_refund_id IS NULL AND created_at < now() - interval '30 seconds' ORDER BY created_at LIMIT 100`,
    );
    for (const r of unsent.rows) await this.sendRefund(r.id).catch((e) => this.logger.warn(`retrying refund ${r.id}: ${e.message}`));
  }

  /** Every closed order still holding a customer's money (or an open checkout) is settled. */
  async settleClosedOrders() {
    if (!this.stripe) return;
    const owed = await this.db.query<{ order_id: string }>(
      `SELECT p.order_id FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.status IN ('cancelled', 'rejected')
          AND ((p.status = 'succeeded' AND p.refunded_minor < p.amount_minor
                AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.origin = 'auto' AND r.status = 'pending'))
               OR p.status = 'requires_payment')
        LIMIT 100`,
    );
    for (const { order_id } of owed.rows) await this.settleClosedOrder(order_id).catch((e) => this.logger.warn(`settling order ${order_id}: ${e.message}`));
  }

  // ---------------------------------------------------------------- listings

  /** The customer's own payment history: what was paid and refunded. No balances; nothing is held. */
  async mine(userId: string, limit: number, cursor?: string) {
    return this.page('p.payer_id = $1', [userId], limit, cursor);
  }

  /** A business's payments, for managers. */
  async forBusiness(userId: string, businessId: string, limit: number, cursor?: string) {
    await this.businesses.requireStaff(userId, businessId, 'payments.view');
    const page = await this.page('p.business_id = $1', [businessId], limit, cursor);
    const totals = await this.db.query<{ currency: string; paid: string; refunded: string; fees: string }>(
      `SELECT currency, sum(amount_minor) AS paid, sum(refunded_minor) AS refunded, sum(fee_minor) AS fees FROM payments WHERE business_id = $1 AND status = 'succeeded' GROUP BY currency`,
      [businessId],
    );
    return { ...page, totals: totals.rows.map((t) => ({ currency: t.currency, paidMinor: Number(t.paid), refundedMinor: Number(t.refunded), feesMinor: Number(t.fees) })) };
  }

  /** Every payment, for the admin dashboard. */
  async all(status: string | undefined, limit: number, cursor?: string) {
    return status ? this.page('p.status = $1', [status], limit, cursor) : this.page('true', [], limit, cursor);
  }

  private async page(where: string, params: unknown[], limit: number, cursor?: string) {
    const p = [...params];
    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      p.push(ts, id);
      where += ` AND (p.created_at, p.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
    }
    p.push(limit + 1);
    const { rows } = await this.db.query<PaymentRow & { business_name: string; business_handle: string }>(
      `SELECT p.*, b.name AS business_name, b.handle AS business_handle FROM payments p JOIN businesses b ON b.id = p.business_id
        WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $${p.length}`,
      p,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      payments: page.map((r) => ({ ...paymentView(r), business: { id: r.business_id, handle: r.business_handle, name: r.business_name } })),
      nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async exportFor(userId: string) {
    const { rows } = await this.db.query(
      `SELECT p.id, p.order_id, p.business_id, p.amount_minor, p.currency, p.status, p.refunded_minor, p.created_at, p.succeeded_at,
              (SELECT json_agg(json_build_object('amountMinor', r.amount_minor, 'status', r.status, 'reason', r.reason, 'createdAt', r.created_at) ORDER BY r.created_at)
                 FROM refunds r WHERE r.payment_id = p.id) AS refunds
         FROM payments p WHERE p.payer_id = $1 ORDER BY p.created_at`,
      [userId],
    );
    return rows;
  }
}

export function paymentView(p: PaymentRow) {
  const amount = Number(p.amount_minor);
  const refunded = Number(p.refunded_minor);
  return {
    id: p.id,
    orderId: p.order_id,
    status: paymentStatus(p.status, amount, refunded),
    amountMinor: amount,
    refundedMinor: refunded,
    refundableMinor: p.status === 'succeeded' ? amount - refunded : 0,
    feeMinor: Number(p.fee_minor),
    currency: p.currency,
    createdAt: p.created_at,
    paidAt: p.succeeded_at,
  };
}

/** One word for clients: unpaid, paid, partially_refunded, refunded or cancelled. */
export function paymentStatus(status: PaymentRow['status'], amount: number, refunded: number) {
  if (status === 'requires_payment') return 'unpaid';
  if (status === 'cancelled') return 'cancelled';
  if (refunded === 0) return 'paid';
  return refunded >= amount ? 'refunded' : 'partially_refunded';
}

function refundView(r: RefundRow) {
  return { id: r.id, amountMinor: Number(r.amount_minor), status: r.status, origin: r.origin, reason: r.reason, createdAt: r.created_at };
}

function synthetic(type: string, object: Record<string, any>): StripeEvent {
  return { id: `sweep_${type}_${object.id}`, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } };
}

/** Maps provider failures to client errors: 502 when it may work later, 409 when it was refused. */
export function rethrowProvider(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.retryable) throw unavailable();
    throw Errors.conflict('payment_provider_refused', `The payment provider refused: ${err.message.replace(/^Stripe answered \d+: /, '')}`);
  }
  throw err;
}

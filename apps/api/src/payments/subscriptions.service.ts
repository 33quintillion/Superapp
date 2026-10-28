import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { BusinessesService } from '../business/businesses.service';
import { Entitlement, ENTITLED_STATUSES, entitlementsOf, LIMITS } from './entitlements';
import { LedgerService } from './ledger';
import { After, BillingHooks, PaymentsService, rethrowProvider as providerFailed } from './payments.service';
import { StripeEvent } from './stripe';

export interface PlanInput {
  code: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: 'month' | 'year';
  entitlements: Entitlement[];
}

interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string;
  price_minor: string;
  currency: string;
  interval: 'month' | 'year';
  entitlements: Entitlement[];
  state: 'draft' | 'active' | 'retired';
  livemode: boolean;
  provider_price_id: string;
  created_at: Date;
}

interface SubscriptionRow {
  id: string;
  business_id: string;
  plan_id: string;
  provider_subscription_id: string;
  status: 'incomplete' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled';
  cancel_at_period_end: boolean;
  current_period_end: Date | null;
  provider_updated_at: Date;
  created_at: Date;
}

const SUBSCRIPTION_EVENTS = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid'];

/**
 * Plans that businesses pay Nexa for, billed by the provider. Plans are sold to
 * businesses on the web, where store billing rules don't apply (ADR 0005); plans for
 * individuals would have to go through the App Store and Google Play and aren't built.
 *
 * The provider is the source of truth for a subscription's status. Its events can arrive
 * in any order, so each one is applied only if it is at least as new as the last one, and
 * a cancelled subscription stays cancelled.
 */
@Injectable()
export class SubscriptionsService implements OnModuleInit, BillingHooks {
  private readonly logger = new Logger('Subscriptions');

  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.payments.useBilling(this);
    this.businesses.onClose((id) => this.endForClosedBusiness(id));
  }

  // ---------------------------------------------------------------- plans

  private planView(p: PlanRow) {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      priceMinor: Number(p.price_minor),
      currency: p.currency,
      interval: p.interval,
      entitlements: p.entitlements,
      state: p.state,
    };
  }

  /** Plans on sale, for owners choosing one. Only plans made with the current key's mode. */
  async plans() {
    const live = this.payments.stripe?.livemode ?? false;
    const { rows } = await this.db.query<PlanRow>(`SELECT * FROM plans WHERE state = 'active' AND livemode = $1 ORDER BY price_minor, name`, [live]);
    return { enabled: this.payments.enabled, plans: rows.map((p) => this.planView(p)) };
  }

  async adminPlans() {
    const { rows } = await this.db.query<PlanRow>(`SELECT * FROM plans ORDER BY state = 'retired', created_at DESC`);
    return { plans: rows.map((p) => this.planView(p)) };
  }

  /** Creates the product and its recurring price at the provider, then the plan as a draft. */
  async createPlan(adminId: string, input: PlanInput) {
    const stripe = this.payments.provider();
    if (await this.db.one('SELECT 1 FROM plans WHERE code = $1', [input.code])) throw Errors.conflict('plan_code_taken', 'A plan with that code exists');
    const product = await stripe.post('/v1/products', { name: input.name, metadata: { plan_code: input.code } }, `plan:${input.code}:product`).catch(providerFailed);
    const price = await stripe
      .post(
        '/v1/prices',
        { product: product.id, unit_amount: input.priceMinor, currency: input.currency.toLowerCase(), recurring: { interval: input.interval }, metadata: { plan_code: input.code } },
        `plan:${input.code}:price:${input.priceMinor}:${input.currency}:${input.interval}`,
      )
      .catch(providerFailed);
    const p = await this.db.one<PlanRow>(
      `INSERT INTO plans (code, name, description, price_minor, currency, interval, entitlements, provider, livemode, provider_product_id, provider_price_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'stripe', $8, $9, $10, $11) RETURNING *`,
      [input.code, input.name, input.description, input.priceMinor, input.currency, input.interval, [...new Set(input.entitlements)], stripe.livemode, product.id, price.id, adminId],
    );
    await this.audit.record({ actorId: adminId, action: 'admin.plan.created', targetType: 'plan', targetId: p!.id, metadata: { code: input.code } });
    return this.planView(p!);
  }

  /** draft → active (on sale) → retired (no new subscribers; existing ones keep it). */
  async setPlanState(adminId: string, planId: string, state: 'active' | 'retired') {
    const p = await this.db.one<PlanRow>(`UPDATE plans SET state = $2, updated_at = now() WHERE id = $1 AND state <> $2 RETURNING *`, [planId, state]);
    if (!p) throw Errors.notFound('Plan');
    await this.audit.record({ actorId: adminId, action: `admin.plan.${state}`, targetType: 'plan', targetId: planId });
    return this.planView(p);
  }

  // ---------------------------------------------------------------- a business's subscription

  private live(businessId: string, q: Queryable = this.db.pool, lock = false) {
    return this.db.one<SubscriptionRow & { plan: PlanRow }>(
      `SELECT s.*, to_jsonb(p) AS plan FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.business_id = $1 AND s.status <> 'canceled' ${lock ? 'FOR UPDATE OF s' : ''}`,
      [businessId],
      q,
    );
  }

  /** The current plan, what it unlocks, and the limits that apply. */
  async forBusiness(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'payments.view');
    const s = await this.live(businessId);
    const ent = await entitlementsOf(this.db, businessId);
    return {
      enabled: this.payments.enabled,
      subscription: s
        ? {
            id: s.id,
            status: s.status,
            plan: this.planView(s.plan),
            cancelAtPeriodEnd: s.cancel_at_period_end,
            currentPeriodEnd: s.current_period_end,
            entitled: ENTITLED_STATUSES.includes(s.status),
          }
        : null,
      entitlements: [...ent],
      limits: Object.fromEntries(Object.entries(LIMITS).map(([k, l]) => [k, ent.has(l.entitlement) ? l.entitled : l.free])),
    };
  }

  /** Starts a hosted checkout for a plan. The subscription exists once the provider says so. */
  async subscribe(userId: string, businessId: string, planCode: string, clientId: string) {
    await this.businesses.requireStaff(userId, businessId, 'billing.manage');
    const stripe = this.payments.provider();
    await this.limits.consume({ name: 'billing:subscribe', limit: 20, windowSeconds: 3600 }, userId);
    const plan = await this.db.one<PlanRow>(`SELECT * FROM plans WHERE code = $1 AND state = 'active' AND livemode = $2`, [planCode, stripe.livemode]);
    if (!plan) throw Errors.notFound('Plan');
    if (await this.live(businessId)) throw Errors.conflict('already_subscribed', 'This business already has a plan; manage it from billing');
    const b = await this.businesses.get(userId, businessId);
    const customer = await this.customer(businessId, b.name);
    const web = this.config.PUBLIC_WEB_URL;
    const back = `${web}/business/${encodeURIComponent(b.handle)}?tab=payments`;
    const meta = { business_id: businessId, plan_id: plan.id };
    const session = await stripe
      .post(
        '/v1/checkout/sessions',
        {
          mode: 'subscription',
          customer,
          client_reference_id: businessId,
          line_items: [{ price: plan.provider_price_id, quantity: 1 }],
          subscription_data: { metadata: meta },
          metadata: meta,
          success_url: `${back}&subscribed=1`,
          cancel_url: back,
        },
        `subscribe:${businessId}:${clientId}`,
      )
      .catch(providerFailed);
    await this.audit.record({ actorId: userId, action: 'billing.checkout.started', targetType: 'business', targetId: businessId, metadata: { plan: plan.code } });
    return { url: session.url as string };
  }

  /** The business as a customer of Nexa at the provider, created once. */
  private async customer(businessId: string, name: string) {
    const stripe = this.payments.provider();
    const have = await this.db.one<{ provider_customer_id: string; livemode: boolean }>('SELECT provider_customer_id, livemode FROM business_billing WHERE business_id = $1', [businessId]);
    if (have && have.livemode === stripe.livemode) return have.provider_customer_id;
    const c = await stripe.post('/v1/customers', { name, metadata: { business_id: businessId } }, `customer:${businessId}:${stripe.livemode ? 'live' : 'test'}`).catch(providerFailed);
    await this.db.query(
      `INSERT INTO business_billing (business_id, provider, livemode, provider_customer_id) VALUES ($1, 'stripe', $2, $3)
         ON CONFLICT (business_id) DO UPDATE SET provider_customer_id = EXCLUDED.provider_customer_id, livemode = EXCLUDED.livemode`,
      [businessId, stripe.livemode, c.id],
    );
    return c.id as string;
  }

  /** Cancel at the end of the paid period (atPeriodEnd) or resume a cancellation. */
  async setCancelAtPeriodEnd(userId: string, businessId: string, cancel: boolean) {
    await this.businesses.requireStaff(userId, businessId, 'billing.manage');
    const stripe = this.payments.provider();
    const s = await this.live(businessId);
    if (!s) throw Errors.notFound('Subscription');
    const sub = await stripe
      .post(`/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}`, { cancel_at_period_end: cancel }, `sub:${s.id}:cancel:${cancel}:${randomUUID()}`)
      .catch(providerFailed);
    await this.db.query(`UPDATE subscriptions SET cancel_at_period_end = $2, updated_at = now() WHERE id = $1 AND status <> 'canceled'`, [s.id, !!sub.cancel_at_period_end]);
    await this.audit.record({ actorId: userId, action: cancel ? 'billing.subscription.cancelled' : 'billing.subscription.resumed', targetType: 'business', targetId: businessId });
    return this.forBusiness(userId, businessId);
  }

  // ---------------------------------------------------------------- changing plan

  /** Checks a change to another plan and fetches what the provider needs to make it. */
  private async changeTarget(userId: string, businessId: string, planCode: string) {
    await this.businesses.requireStaff(userId, businessId, 'billing.manage');
    const stripe = this.payments.provider();
    const s = await this.live(businessId);
    if (!s) throw Errors.notFound('Subscription');
    if (s.status !== 'active' && s.status !== 'trialing') throw Errors.conflict('subscription_not_active', 'Bring the plan up to date (check the card on billing) before changing it');
    if (s.cancel_at_period_end) throw Errors.conflict('subscription_ending', 'This plan is set to end; resume it before changing it');
    const plan = await this.db.one<PlanRow>(`SELECT * FROM plans WHERE code = $1 AND state = 'active' AND livemode = $2`, [planCode, stripe.livemode]);
    if (!plan) throw Errors.notFound('Plan');
    if (plan.id === s.plan_id) throw Errors.conflict('same_plan', 'This business is already on that plan');
    if (plan.currency !== s.plan.currency) throw Errors.conflict('currency_mismatch', 'That plan is billed in another currency; cancel this plan and subscribe to it instead');
    const sub = await stripe.get(`/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}`).catch(providerFailed);
    const item = sub.items?.data?.[0];
    if (!item?.id) throw Errors.conflict('payment_provider_refused', 'The payment provider returned a subscription without items');
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    return { s, plan, itemId: item.id as string, customer: customer as string };
  }

  /**
   * What switching plan would cost today. The provider credits the unused part of the current
   * plan and charges for the new one from now; the difference is billed straight away (a
   * negative amount is a credit towards the next invoices).
   */
  async previewChange(userId: string, businessId: string, planCode: string) {
    const t = await this.changeTarget(userId, businessId, planCode);
    const preview = await this.payments
      .provider()
      .post(
        '/v1/invoices/create_preview',
        {
          customer: t.customer,
          subscription: t.s.provider_subscription_id,
          subscription_details: { items: [{ id: t.itemId, price: t.plan.provider_price_id }], proration_behavior: 'always_invoice' },
        },
        `preview:${t.s.id}:${t.plan.id}:${randomUUID()}`,
      )
      .catch(providerFailed);
    const total = Number(preview.total ?? preview.amount_due ?? 0);
    return {
      plan: this.planView(t.plan),
      from: this.planView(t.s.plan),
      // What is charged now; below zero is credit kept for later invoices.
      amountDueNowMinor: total,
      currency: String(preview.currency ?? t.plan.currency).toUpperCase(),
      intervalChanges: t.plan.interval !== t.s.plan.interval,
    };
  }

  /**
   * Switches plan in place. The provider charges or credits the difference now; if an
   * upgrade can't be paid, nothing changes. Limits follow the new plan at once; when they
   * go down, nothing is removed, but adding more is refused (as when a plan lapses).
   */
  async changePlan(userId: string, businessId: string, planCode: string, clientId: string) {
    const t = await this.changeTarget(userId, businessId, planCode);
    await this.limits.consume({ name: 'billing:change', limit: 10, windowSeconds: 3600 }, userId);
    const sub = await this.payments
      .provider()
      .post(
        `/v1/subscriptions/${encodeURIComponent(t.s.provider_subscription_id)}`,
        {
          items: [{ id: t.itemId, price: t.plan.provider_price_id }],
          proration_behavior: 'always_invoice',
          // An upgrade whose charge fails is refused instead of leaving the plan half-paid.
          payment_behavior: 'error_if_incomplete',
          metadata: { business_id: businessId, plan_id: t.plan.id },
        },
        `change:${t.s.id}:${clientId}`,
      )
      .catch(providerFailed);
    await this.db.tx(async (tx) => {
      await this.applyCurrent(sub, tx);
      await this.db.query('UPDATE subscriptions SET plan_changed_at = now() WHERE id = $1', [t.s.id], tx);
    });
    await this.audit.record({ actorId: userId, action: 'billing.subscription.changed', targetType: 'business', targetId: businessId, metadata: { from: t.s.plan.code, to: t.plan.code } });
    return this.forBusiness(userId, businessId);
  }

  /**
   * Applies the provider's current copy of a subscription (from an API answer, not an event).
   * It is as new as anything we have, so it is stamped with the time it was read.
   */
  private async applyCurrent(sub: Record<string, any>, tx: Queryable) {
    const s = await this.db.one<SubscriptionRow>('SELECT * FROM subscriptions WHERE provider_subscription_id = $1 FOR UPDATE', [sub.id], tx);
    if (!s || s.status === 'canceled') return;
    const planId = await this.planForPrice(sub, tx);
    const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
    await this.db.query(
      `UPDATE subscriptions SET plan_id = coalesce($2, plan_id), status = $3, cancel_at_period_end = $4, current_period_end = coalesce($5, current_period_end),
              provider_updated_at = greatest(provider_updated_at, date_trunc('second', now())), updated_at = now() WHERE id = $1`,
      [s.id, planId, normaliseStatus(sub.status), !!sub.cancel_at_period_end, periodEnd ? new Date(periodEnd * 1000) : null],
      tx,
    );
  }

  /** Our plan for the subscription's price, if we know it. */
  private async planForPrice(sub: Record<string, any>, tx: Queryable) {
    const price = sub.items?.data?.[0]?.price;
    const priceId = typeof price === 'string' ? price : price?.id;
    if (!priceId) return null;
    return (await this.db.one<{ id: string }>('SELECT id FROM plans WHERE provider_price_id = $1', [priceId], tx))?.id ?? null;
  }

  /** Reads the subscription from the provider and applies it, when an event may have been out of date. */
  private async refresh(providerSubscriptionId: string) {
    const sub = await this.payments.provider().get(`/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    await this.db.tx((tx) => this.applyCurrent(sub, tx));
  }

  /** The provider's billing page, where the owner changes card or downloads invoices. */
  async portal(userId: string, businessId: string) {
    await this.businesses.requireStaff(userId, businessId, 'billing.manage');
    const stripe = this.payments.provider();
    const billing = await this.db.one<{ provider_customer_id: string }>('SELECT provider_customer_id FROM business_billing WHERE business_id = $1', [businessId]);
    if (!billing) throw Errors.notFound('Billing account');
    const b = await this.businesses.get(userId, businessId);
    const res = await stripe
      .post('/v1/billing_portal/sessions', { customer: billing.provider_customer_id, return_url: `${this.config.PUBLIC_WEB_URL}/business/${encodeURIComponent(b.handle)}?tab=payments` }, `portal:${businessId}:${randomUUID()}`)
      .catch(providerFailed);
    return { url: res.url as string };
  }

  /** A closed business stops paying straight away. */
  private async endForClosedBusiness(businessId: string) {
    const s = await this.live(businessId);
    if (!s || !this.payments.stripe) return;
    try {
      await this.payments.stripe.delete(`/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}`, `sub:${s.id}:end`);
    } catch (err) {
      this.logger.error(`could not end subscription ${s.id} of closed business ${businessId}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- provider events (BillingHooks)

  handles(type: string) {
    return SUBSCRIPTION_EVENTS.includes(type);
  }

  async apply(event: StripeEvent, tx: Queryable, after: After) {
    const o = event.data.object;
    if (event.type === 'invoice.paid') return this.invoicePaid(o, tx);
    if (event.type === 'checkout.session.completed') {
      // The subscription's own events carry its status; this only links it if they haven't arrived.
      if (typeof o.subscription === 'string') await this.upsert({ id: o.subscription, status: o.payment_status === 'paid' ? 'active' : 'incomplete', metadata: o.metadata ?? {} }, event.created, tx, after, true);
      return;
    }
    await this.upsert(o, event.created, tx, after, false);
  }

  private async upsert(sub: Record<string, any>, created: number, tx: Queryable, after: After, fromCheckout: boolean) {
    const at = new Date(created * 1000);
    const existing = await this.db.one<SubscriptionRow>('SELECT * FROM subscriptions WHERE provider_subscription_id = $1 FOR UPDATE', [sub.id], tx);
    const status = normaliseStatus(sub.status);
    const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
    if (existing) {
      if (fromCheckout || existing.status === 'canceled' || at < existing.provider_updated_at) return;
      const planId = await this.planForPrice(sub, tx);
      await this.db.query(
        `UPDATE subscriptions SET plan_id = coalesce($6, plan_id), status = $2, cancel_at_period_end = $3, current_period_end = $4, provider_updated_at = $5, updated_at = now() WHERE id = $1`,
        [existing.id, status, !!sub.cancel_at_period_end, periodEnd ? new Date(periodEnd * 1000) : existing.current_period_end, at, planId],
        tx,
      );
      // An event from the same second as a plan change may predate it; ask the provider which is current.
      if (planId && planId !== existing.plan_id && status !== 'canceled') after.push(() => this.refresh(sub.id));
      return;
    }
    const businessId = sub.metadata?.business_id;
    const planId = sub.metadata?.plan_id;
    if (!businessId || !planId) {
      this.logger.warn(`subscription ${sub.id} has no business or plan in its metadata; ignored`);
      return;
    }
    // One live plan per business. A second one (two checkouts finished in two tabs) is ended at once.
    await this.db.query('SELECT 1 FROM businesses WHERE id = $1 FOR UPDATE', [businessId], tx);
    const other = await this.live(businessId, tx);
    if (other && status !== 'canceled') {
      this.logger.warn(`business ${businessId} already has subscription ${other.id}; ending duplicate ${sub.id}`);
      after.push(() => this.payments.provider().delete(`/v1/subscriptions/${encodeURIComponent(sub.id)}`, `sub:${sub.id}:duplicate`));
      return;
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO subscriptions (business_id, plan_id, provider, provider_subscription_id, status, cancel_at_period_end, current_period_end, provider_updated_at)
       VALUES ($1, $2, 'stripe', $3, $4, $5, $6, $7) RETURNING id`,
      [businessId, planId, sub.id, status, !!sub.cancel_at_period_end, periodEnd ? new Date(periodEnd * 1000) : null, fromCheckout ? new Date(0) : at],
      tx,
    );
    await this.audit.record({ actorId: null, action: 'billing.subscription.started', targetType: 'business', targetId: businessId, metadata: { subscriptionId: row!.id } }, tx);
  }

  private async invoicePaid(inv: Record<string, any>, tx: Queryable) {
    const amount = Number(inv.amount_paid ?? 0);
    if (amount <= 0) return;
    const subId = inv.subscription ?? inv.parent?.subscription_details?.subscription;
    const s = subId ? await this.db.one<{ id: string }>('SELECT id FROM subscriptions WHERE provider_subscription_id = $1', [subId], tx) : null;
    await this.ledger.post(
      {
        kind: 'subscription_invoice',
        providerRef: inv.id,
        currency: String(inv.currency).toUpperCase(),
        subscriptionId: s?.id,
        entries: [
          ['external:customers', -amount],
          ['platform:subscriptions', amount],
        ],
      },
      tx,
    );
  }
}

function normaliseStatus(s: string): SubscriptionRow['status'] {
  // incomplete_expired and paused don't keep features on; treat them as their nearest status.
  if (s === 'incomplete_expired') return 'canceled';
  if (s === 'paused') return 'unpaid';
  return (['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled'] as const).find((x) => x === s) ?? 'incomplete';
}

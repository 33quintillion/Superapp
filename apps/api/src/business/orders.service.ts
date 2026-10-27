import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { limitFor } from '../payments/entitlements';
import { OrderHooks, PaymentsService, paymentStatus } from '../payments/payments.service';
import { RealtimeBus } from '../realtime/realtime-bus.service';
import { userSummary } from '../social/follows.service';
import { BusinessesService } from './businesses.service';

export interface ItemInput {
  name: string;
  description: string;
  priceMinor: number;
  available: boolean;
  stock: number | null;
  position: number;
}

export type OrderStatus = 'pending_payment' | 'placed' | 'accepted' | 'ready' | 'completed' | 'cancelled' | 'rejected';

/**
 * What business staff may move an order to, from each status. Customers may only cancel
 * an order the business hasn't accepted. An online order waits in pending_payment, out of
 * staff's hands, until the provider confirms the payment.
 */
const STAFF_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: [],
  placed: ['accepted', 'rejected'],
  accepted: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rejected: [],
};
const RESTOCK: OrderStatus[] = ['cancelled', 'rejected'];

export const MAX_ORDER_LINES = 50;

interface ItemRow {
  id: string;
  business_id: string;
  name: string;
  description: string;
  price_minor: string;
  available: boolean;
  stock: number | null;
  position: number;
  archived_at: Date | null;
}

interface OrderRow {
  id: string;
  business_id: string;
  business_handle: string;
  business_name: string;
  customer_id: string | null;
  customer_username: string | null;
  customer_display_name: string | null;
  status: OrderStatus;
  fulfilment: string;
  payment: string;
  note: string;
  total_minor: string;
  currency: string;
  status_reason: string;
  created_at: Date;
  updated_at: Date;
  items: { itemId: string | null; name: string; unitPriceMinor: number; quantity: number }[];
  pay_status: 'requires_payment' | 'succeeded' | 'cancelled' | null;
  pay_refunded: string | null;
}

const ORDER_SELECT = `
  SELECT o.id, o.business_id, b.handle AS business_handle, b.name AS business_name, o.customer_id,
         u.username AS customer_username, u.display_name AS customer_display_name,
         o.status, o.fulfilment, o.payment, o.note, o.total_minor, o.currency, o.status_reason, o.created_at, o.updated_at,
         (SELECT json_agg(json_build_object('itemId', i.item_id, 'name', i.name, 'unitPriceMinor', i.unit_price_minor, 'quantity', i.quantity) ORDER BY i.position)
            FROM order_items i WHERE i.order_id = o.id) AS items,
         p.status AS pay_status, p.refunded_minor AS pay_refunded
    FROM orders o JOIN businesses b ON b.id = o.business_id LEFT JOIN users u ON u.id = o.customer_id
    LEFT JOIN payments p ON p.order_id = o.id`;

/** Staff only see online orders once they are paid; an abandoned checkout is none of their business. */
const STAFF_VISIBLE = `(o.payment = 'pay_in_person' OR p.status = 'succeeded')`;

export interface PlaceInput {
  clientId: string;
  items: { itemId: string; quantity: number }[];
  note: string;
  payment: 'pay_in_person' | 'online';
}

@Injectable()
export class OrdersService implements OnModuleInit, OrderHooks {
  constructor(
    private readonly db: DatabaseService,
    private readonly businesses: BusinessesService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly bus: RealtimeBus,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit() {
    this.payments.useOrders(this);
    this.businesses.onClose(() => this.payments.settleClosedOrders());
  }

  // ---------------------------------------------------------------- catalogue

  private itemView(r: ItemRow, currency: string) {
    return {
      id: r.id,
      businessId: r.business_id,
      name: r.name,
      description: r.description,
      priceMinor: Number(r.price_minor),
      currency,
      available: r.available && (r.stock === null || r.stock > 0),
      stock: r.stock,
      position: r.position,
      archived: !!r.archived_at,
    };
  }

  /** Customers see what can be bought; staff (all=true) also see hidden and sold-out items. */
  async items(viewerId: string, businessId: string, all: boolean) {
    const b = await this.businesses.get(viewerId, businessId);
    if (all) await this.businesses.requireStaff(viewerId, b.id, 'business.view');
    const { rows } = await this.db.query<ItemRow>(
      `SELECT * FROM catalogue_items WHERE business_id = $1 AND archived_at IS NULL ${all ? '' : 'AND available'} ORDER BY position, created_at`,
      [b.id],
    );
    return { items: rows.map((r) => this.itemView(r, b.currency)) };
  }

  async createItem(userId: string, businessId: string, input: ItemInput) {
    await this.businesses.requireStaff(userId, businessId, 'catalogue.manage');
    const count = await this.db.one<{ n: string }>('SELECT count(*) AS n FROM catalogue_items WHERE business_id = $1 AND archived_at IS NULL', [businessId]);
    const max = await limitFor(this.db, businessId, 'catalogue');
    if (Number(count!.n) >= max) throw Errors.conflict('catalogue_full', `A catalogue can hold up to ${max} items on this plan`, { limit: max });
    const r = await this.db.one<ItemRow>(
      `INSERT INTO catalogue_items (business_id, name, description, price_minor, available, stock, position) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [businessId, input.name, input.description, input.priceMinor, input.available, input.stock, input.position],
    );
    return this.itemView(r!, await this.currency(businessId));
  }

  async updateItem(userId: string, businessId: string, itemId: string, patch: Partial<ItemInput>) {
    await this.businesses.requireStaff(userId, businessId, 'catalogue.manage');
    const columns: Record<string, string> = { name: 'name', description: 'description', priceMinor: 'price_minor', available: 'available', stock: 'stock', position: 'position' };
    const sets: string[] = [];
    const params: unknown[] = [itemId, businessId];
    for (const [k, col] of Object.entries(columns)) {
      if (k in patch) {
        params.push((patch as Record<string, unknown>)[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    const r = await this.db.one<ItemRow>(
      `UPDATE catalogue_items SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 AND business_id = $2 AND archived_at IS NULL RETURNING *`,
      params,
    );
    if (!r) throw Errors.notFound('Item');
    return this.itemView(r, await this.currency(businessId));
  }

  /** Archived, not deleted: past orders keep their copy of the name and price anyway. */
  async archiveItem(userId: string, businessId: string, itemId: string) {
    await this.businesses.requireStaff(userId, businessId, 'catalogue.manage');
    const r = await this.db.query('UPDATE catalogue_items SET archived_at = now() WHERE id = $1 AND business_id = $2 AND archived_at IS NULL', [itemId, businessId]);
    if (!r.rowCount) throw Errors.notFound('Item');
  }

  private async currency(businessId: string) {
    return (await this.db.one<{ currency: string }>('SELECT currency FROM businesses WHERE id = $1', [businessId]))!.currency;
  }

  // ---------------------------------------------------------------- orders

  private orderView(r: OrderRow, forStaff: boolean) {
    return {
      id: r.id,
      business: { id: r.business_id, handle: r.business_handle, name: r.business_name },
      // Staff see who to hand it to; never their email or phone.
      customer: forStaff ? (r.customer_id ? userSummary({ id: r.customer_id, username: r.customer_username, display_name: r.customer_display_name ?? '' }) : null) : undefined,
      status: r.status,
      statusReason: r.status_reason,
      fulfilment: r.fulfilment,
      payment: r.payment,
      // For online orders: unpaid, paid, partially_refunded, refunded or cancelled.
      paymentStatus: r.pay_status ? paymentStatus(r.pay_status, Number(r.total_minor), Number(r.pay_refunded)) : null,
      refundedMinor: Number(r.pay_refunded ?? 0),
      note: r.note,
      items: r.items ?? [],
      totalMinor: Number(r.total_minor),
      currency: r.currency,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Places an order. Prices come from the catalogue, never from the client. Stock is taken
   * in the same transaction, and a retry with the same clientId returns the first order.
   * An online order holds its stock in pending_payment until the payment arrives; the
   * customer then gets the hosted checkout from POST /v1/orders/:id/checkout.
   */
  async place(customerId: string, businessId: string, input: PlaceInput) {
    const existing = await this.findByClientId(customerId, input.clientId);
    if (existing) return { order: existing, created: false };
    const b = await this.businesses.get(customerId, businessId);
    if (b.state !== 'active') throw Errors.notFound('Business');
    if (!b.ordersEnabled) throw Errors.conflict('orders_closed', 'This business isn’t taking orders right now');
    if (input.payment === 'pay_in_person' && !b.payments.inPerson) throw Errors.conflict('in_person_not_accepted', 'This business only takes payment online');
    if (input.payment === 'online' && !b.payments.online) throw Errors.conflict('online_payments_unavailable', 'This business can’t take payment online yet; choose pay at pickup');
    await this.limits.consume({ name: 'order:place', limit: 30, windowSeconds: 3600 }, customerId);
    // Merge repeated lines and lock items in a fixed order so concurrent orders can't deadlock.
    const lines = new Map<string, number>();
    for (const l of input.items) lines.set(l.itemId, (lines.get(l.itemId) ?? 0) + l.quantity);
    if ([...lines.values()].some((q) => q > 99)) throw Errors.validation([{ path: 'items', message: 'Up to 99 of each item' }]);
    const sorted = [...lines.entries()].sort(([a], [z]) => a.localeCompare(z));

    const orderId = await this.db.tx(async (tx) => {
      const online = input.payment === 'online';
      const o = await this.db.one<{ id: string }>(
        `INSERT INTO orders (business_id, customer_id, client_id, note, total_minor, currency, payment, status) VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
           ON CONFLICT (customer_id, client_id) DO NOTHING RETURNING id`,
        [b.id, customerId, input.clientId, input.note, b.currency, input.payment, online ? 'pending_payment' : 'placed'],
        tx,
      );
      if (!o) return null; // a concurrent retry got there first
      let total = 0;
      for (const [i, [itemId, quantity]] of sorted.entries()) {
        const item = await this.db.one<{ name: string; price_minor: string }>(
          `UPDATE catalogue_items SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - $3 END
            WHERE id = $1 AND business_id = $2 AND available AND archived_at IS NULL AND (stock IS NULL OR stock >= $3)
            RETURNING name, price_minor`,
          [itemId, b.id, quantity],
          tx,
        );
        if (!item) throw Errors.conflict('item_unavailable', 'Something in your order is sold out or no longer available', { itemId });
        total += Number(item.price_minor) * quantity;
        await this.db.query(
          'INSERT INTO order_items (order_id, position, item_id, name, unit_price_minor, quantity) VALUES ($1, $2, $3, $4, $5, $6)',
          [o.id, i, itemId, item.name, item.price_minor, quantity],
          tx,
        );
      }
      await this.db.query('UPDATE orders SET total_minor = $2 WHERE id = $1', [o.id, total], tx);
      if (online) await this.payments.prepareForOrder(tx, { orderId: o.id, businessId: b.id, payerId: customerId, amountMinor: total, currency: b.currency });
      return o.id;
    });
    if (!orderId) return { order: (await this.findByClientId(customerId, input.clientId))!, created: false };
    const order = (await this.load(orderId))!;
    if (order.status === 'placed') await this.bus.publish(await this.businesses.staffIds(b.id), { type: 'business.order.created', data: this.orderView(order, true) });
    return { order: this.orderView(order, false), created: true };
  }

  // ---------------------------------------------------------------- payment hooks (OrderHooks)

  async paid(orderId: string, tx: Queryable) {
    const r = await this.db.query(
      `UPDATE orders SET status = 'placed', updated_at = date_trunc('milliseconds', now()) WHERE id = $1 AND status = 'pending_payment'`,
      [orderId],
      tx,
    );
    return (r.rowCount ?? 0) > 0;
  }

  async unpaid(orderId: string, reason: string, tx: Queryable) {
    const r = await this.db.query(
      `UPDATE orders SET status = 'cancelled', status_reason = $2, updated_at = date_trunc('milliseconds', now()) WHERE id = $1 AND status = 'pending_payment'`,
      [orderId, reason],
      tx,
    );
    if (!r.rowCount) return false;
    await this.restock(orderId, tx);
    return true;
  }

  async announce(orderId: string, created: boolean) {
    const r = await this.load(orderId);
    if (!r) return;
    if (r.customer_id) await this.bus.publish([r.customer_id], { type: 'order.updated', data: this.orderView(r, false) });
    if (r.payment === 'online' && r.pay_status !== 'succeeded') return;
    await this.bus.publish(await this.businesses.staffIds(r.business_id), { type: created ? 'business.order.created' : 'business.order.updated', data: this.orderView(r, true) });
  }

  private async restock(orderId: string, tx: Queryable) {
    await this.db.query(
      `UPDATE catalogue_items c SET stock = c.stock + i.quantity FROM order_items i WHERE i.order_id = $1 AND c.id = i.item_id AND c.stock IS NOT NULL`,
      [orderId],
      tx,
    );
  }

  private async findByClientId(customerId: string, clientId: string) {
    const r = await this.db.one<OrderRow>(`${ORDER_SELECT} WHERE o.customer_id = $1 AND o.client_id = $2`, [customerId, clientId]);
    return r ? this.orderView(r, false) : null;
  }

  private load(orderId: string, db: Queryable = this.db.pool) {
    return this.db.one<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [orderId], db);
  }

  /** The customer, or staff of the business who may view orders. */
  async get(userId: string, orderId: string) {
    const r = await this.load(orderId);
    if (!r) throw Errors.notFound('Order');
    if (r.customer_id === userId) return this.orderView(r, false);
    await this.businesses.requireStaff(userId, r.business_id, 'orders.view').catch(() => {
      throw Errors.notFound('Order');
    });
    return this.orderView(r, true);
  }

  async mine(customerId: string, limit: number, cursor?: string) {
    return this.page(`o.customer_id = $1`, [customerId], limit, cursor, false);
  }

  async forBusiness(userId: string, businessId: string, status: OrderStatus[] | undefined, limit: number, cursor?: string) {
    await this.businesses.requireStaff(userId, businessId, 'orders.view');
    const params: unknown[] = [businessId];
    let where = `o.business_id = $1 AND ${STAFF_VISIBLE}`;
    if (status?.length) {
      params.push(status);
      where += ` AND o.status = ANY($${params.length})`;
    }
    return this.page(where, params, limit, cursor, true);
  }

  private async page(where: string, params: unknown[], limit: number, cursor: string | undefined, forStaff: boolean) {
    const p = [...params];
    if (cursor) {
      const [ts, id] = decodeCursor(cursor);
      p.push(ts, id);
      where += ` AND (o.created_at, o.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
    }
    p.push(limit + 1);
    const { rows } = await this.db.query<OrderRow>(`${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT $${p.length}`, p);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { orders: page.map((r) => this.orderView(r, forStaff)), nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null };
  }

  async cancelByCustomer(customerId: string, orderId: string) {
    return this.transition(orderId, async (o) => {
      if (o.customer_id !== customerId) throw Errors.notFound('Order');
      if (o.status !== 'placed' && o.status !== 'pending_payment') throw Errors.conflict('order_in_progress', 'The business has already accepted this order; contact them to cancel');
      return { to: 'cancelled', reason: 'Cancelled by the customer', actor: customerId, asStaff: false };
    });
  }

  async setStatus(userId: string, orderId: string, to: OrderStatus, reason: string) {
    return this.transition(orderId, async (o, tx) => {
      await this.businesses.requireStaff(userId, o.business_id, 'orders.manage', tx).catch((e) => {
        throw o.customer_id === userId ? Errors.forbidden('Only the business can do that') : e;
      });
      if (!STAFF_TRANSITIONS[o.status].includes(to)) throw Errors.conflict('invalid_transition', `A ${o.status} order can’t be marked ${to}`);
      return { to, reason, actor: userId, asStaff: true };
    });
  }

  private async transition(
    orderId: string,
    decide: (o: { business_id: string; customer_id: string | null; status: OrderStatus }, tx: Queryable) => Promise<{ to: OrderStatus; reason: string; actor: string; asStaff: boolean }>,
  ) {
    const out = await this.db.tx(async (tx) => {
      const o = await this.db.one<{ business_id: string; customer_id: string | null; status: OrderStatus }>(
        'SELECT business_id, customer_id, status FROM orders WHERE id = $1 FOR UPDATE',
        [orderId],
        tx,
      );
      if (!o) throw Errors.notFound('Order');
      const d = await decide(o, tx);
      await this.db.query(`UPDATE orders SET status = $2, status_reason = $3, updated_at = date_trunc('milliseconds', now()) WHERE id = $1`, [orderId, d.to, d.reason], tx);
      if (RESTOCK.includes(d.to)) await this.restock(orderId, tx);
      await this.audit.record({ actorId: d.actor, action: 'business.order.status', targetType: 'order', targetId: orderId, metadata: { from: o.status, to: d.to } }, tx);
      return { asStaff: d.asStaff };
    });
    // A closed online order stops its checkout or refunds the customer in full. If the
    // provider can't be reached now, the payments sweep finishes the job.
    if (RESTOCK.includes((await this.load(orderId))!.status)) await this.payments.settleClosedOrder(orderId).catch(() => undefined);
    await this.announce(orderId, false);
    return this.orderView((await this.load(orderId))!, out.asStaff);
  }
}
